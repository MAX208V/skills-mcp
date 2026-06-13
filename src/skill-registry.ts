// ============================================================
//  Skill 注册中心 - 管理内置 + 动态 Skill 的注册与查找
// ============================================================

import type {
  Env,
  SkillDefinition,
  DynamicSkillDef,
  McpTool,
  ToolHandler,
  ToolResult,
  HttpHandlerConfig,
} from "./types";

import { wechatReadingSkill } from "./skills/wechat-reading";

// ---- 内置 Skill 列表 ----
const BUILTIN_SKILLS: SkillDefinition[] = [wechatReadingSkill];

export class SkillRegistry {
  private builtinSkills: SkillDefinition[] = BUILTIN_SKILLS;
  private dynamicSkills: Map<string, DynamicSkillDef> = new Map();
  private env: Env | null = null;

  /** 获取 KV 键前缀（来自环境变量或默认值） */
  private get kvPrefix(): string {
    return this.env?.KV_PREFIX ?? "skill:";
  }

  /** 获取 KV 列表键名（来自环境变量或默认值） */
  private get kvListKey(): string {
    return this.env?.KV_LIST_KEY ?? "skills:registry";
  }

  /** 绑定环境（每次请求时调用） */
  bindEnv(env: Env) {
    this.env = env;
  }

  /** 从 KV 加载动态 Skill */
  async loadFromKV(): Promise<void> {
    if (!this.env?.SKILLS_KV) return;

    try {
      const raw = await this.env.SKILLS_KV.get(this.kvListKey, "json");
      if (raw && Array.isArray(raw)) {
        this.dynamicSkills.clear();
        for (const def of raw as DynamicSkillDef[]) {
          this.dynamicSkills.set(def.name, def);
        }
      }
    } catch {
      // KV 不可用时静默降级
    }
  }

  /** 保存动态 Skill 列表到 KV */
  private async saveToKV(): Promise<void> {
    if (!this.env?.SKILLS_KV) return;
    const list = Array.from(this.dynamicSkills.values());
    await this.env.SKILLS_KV.put(this.kvListKey, JSON.stringify(list));
  }

  // ---- 查询 ----

  /** 获取所有 MCP 工具定义（内置 + 动态） */
  listTools(): McpTool[] {
    const tools: McpTool[] = [];

    // 内置 Skill 的工具
    for (const skill of this.builtinSkills) {
      for (const tool of skill.tools) {
        tools.push({
          name: tool.name,
          description: `[${skill.name}] ${tool.description}`,
          inputSchema: tool.inputSchema,
        });
      }
    }

    // 动态 Skill 的工具
    for (const [, skill] of this.dynamicSkills) {
      for (const tool of skill.tools) {
        tools.push({
          name: tool.name,
          description: `[${skill.name}] ${tool.description}`,
          inputSchema: tool.inputSchema,
        });
      }
    }

    // 管理工具
    tools.push(
      {
        name: "skills_add",
        description:
          "添加一个新的 Skill 到注册中心（等价于 npx skills add <source> -g）。" +
          "提供 source 即可自动匹配内置定义，或提供完整的 definition 来自定义",
        inputSchema: {
          type: "object",
          properties: {
            source: {
              type: "string",
              description: 'Skill 来源，如 "Tencent/WeChatReading"',
            },
            definition: {
              type: "object",
              description: "自定义 Skill 定义（可选，不提供则从内置映射查找）",
              properties: {
                name: { type: "string", description: "Skill 标识名" },
                description: { type: "string", description: "Skill 描述" },
                tools: {
                  type: "array",
                  description: "工具定义列表",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      description: { type: "string" },
                      inputSchema: { type: "object" },
                    },
                    required: ["name", "description", "inputSchema"],
                  },
                },
                httpHandlers: {
                  type: "object",
                  description: "HTTP 代理处理器配置，key 为工具名",
                },
              },
            },
          },
          required: ["source"],
        },
      },
      {
        name: "skills_list",
        description: "列出所有已注册的 Skill",
        inputSchema: {
          type: "object",
          properties: {
            verbose: {
              type: "boolean",
              description: "是否显示详细信息，默认 false",
            },
          },
          required: [],
        },
      },
      {
        name: "skills_remove",
        description: "移除一个已注册的动态 Skill",
        inputSchema: {
          type: "object",
          properties: {
            name: {
              type: "string",
              description: "要移除的 Skill 标识名",
            },
          },
          required: ["name"],
        },
      }
    );

    return tools;
  }

  /** 执行工具调用 */
  async callTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    // 1. 管理工具
    if (name === "skills_add") return this.handleAdd(params);
    if (name === "skills_list") return this.handleList(params);
    if (name === "skills_remove") return this.handleRemove(params);

    // 2. 内置 Skill 处理器
    for (const skill of this.builtinSkills) {
      if (skill.handlers[name]) {
        return skill.handlers[name](params, this.env!);
      }
    }

    // 3. 动态 Skill 处理器（HTTP 代理）
    for (const [, skill] of this.dynamicSkills) {
      if (skill.httpHandlers?.[name]) {
        return this.handleDynamicHttp(skill.httpHandlers[name], params);
      }
    }

    return {
      content: [{ type: "text", text: `未知工具: ${name}` }],
      isError: true,
    };
  }

  // ---- 管理工具实现 ----

  /** source -> 内置 Skill 的映射 */
  private static SOURCE_MAP: Record<string, string> = {
    "Tencent/WeChatReading": "wechat-reading",
    "wechat-reading": "wechat-reading",
  };

  private async handleAdd(params: Record<string, unknown>): Promise<ToolResult> {
    const source = String(params.source ?? "");
    const definition = params.definition as DynamicSkillDef | undefined;

    if (!source) {
      return {
        content: [{ type: "text", text: "请提供 source 参数" }],
        isError: true,
      };
    }

    // 方案 A：从内置映射查找
    const mappedName = SkillRegistry.SOURCE_MAP[source];
    if (mappedName) {
      const builtin = this.builtinSkills.find((s) => s.name === mappedName);
      if (builtin) {
        return {
          content: [
            {
              type: "text",
              text: `✅ Skill "${source}" 已作为内置 Skill 存在，可直接使用以下工具:\n${builtin.tools.map((t) => `  - ${t.name}: ${t.description}`).join("\n")}`,
            },
          ],
        };
      }
    }

    // 方案 B：使用自定义 definition
    if (definition) {
      const def: DynamicSkillDef = {
        name: definition.name ?? source.split("/").pop() ?? source,
        source,
        description: definition.description ?? `Dynamic skill from ${source}`,
        tools: definition.tools ?? [],
        httpHandlers: definition.httpHandlers,
      };

      this.dynamicSkills.set(def.name, def);
      await this.saveToKV();

      return {
        content: [
          {
            type: "text",
            text: `✅ 动态 Skill "${def.name}" 添加成功！包含 ${def.tools.length} 个工具:\n${def.tools.map((t) => `  - ${t.name}: ${t.description}`).join("\n")}`,
          },
        ],
      };
    }

    // 方案 C：未知 source，提示
    return {
      content: [
        {
          type: "text",
          text: `⚠️ 未找到内置 Skill "${source}"。\n请提供 definition 参数来自定义此 Skill，例如:\n{\n  "source": "${source}",\n  "definition": {\n    "name": "my-skill",\n    "description": "...",\n    "tools": [{ "name": "my_tool", "description": "...", "inputSchema": {...} }],\n    "httpHandlers": { "my_tool": { "url": "https://...", "method": "GET" } }\n  }\n}`,
        },
      ],
      isError: true,
    };
  }

  private async handleList(params: Record<string, unknown>): Promise<ToolResult> {
    const verbose = Boolean(params.verbose);
    const skills: Record<string, unknown>[] = [];

    for (const skill of this.builtinSkills) {
      skills.push(
        verbose
          ? {
              name: skill.name,
              source: skill.source,
              description: skill.description,
              type: "builtin",
              tools: skill.tools.map((t) => t.name),
            }
          : { name: skill.name, source: skill.source, type: "builtin" }
      );
    }

    for (const [, skill] of this.dynamicSkills) {
      skills.push(
        verbose
          ? {
              name: skill.name,
              source: skill.source,
              description: skill.description,
              type: "dynamic",
              tools: skill.tools.map((t) => t.name),
            }
          : { name: skill.name, source: skill.source, type: "dynamic" }
      );
    }

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ total: skills.length, skills }, null, 2),
        },
      ],
    };
  }

  private async handleRemove(params: Record<string, unknown>): Promise<ToolResult> {
    const name = String(params.name ?? "");
    if (!name) {
      return {
        content: [{ type: "text", text: "请提供 name 参数" }],
        isError: true,
      };
    }

    // 不允许移除内置 Skill
    if (this.builtinSkills.some((s) => s.name === name)) {
      return {
        content: [
          {
            type: "text",
            text: `❌ 内置 Skill "${name}" 不可移除`,
          },
        ],
        isError: true,
      };
    }

    if (!this.dynamicSkills.has(name)) {
      return {
        content: [{ type: "text", text: `❌ 未找到 Skill "${name}"` }],
        isError: true,
      };
    }

    this.dynamicSkills.delete(name);
    await this.saveToKV();

    return {
      content: [{ type: "text", text: `✅ Skill "${name}" 已移除` }],
    };
  }

  // ---- 动态 Skill HTTP 代理 ----

  private async handleDynamicHttp(
    config: HttpHandlerConfig,
    params: Record<string, unknown>
  ): Promise<ToolResult> {
    try {
      // 模板变量替换
      const resolve = (template: string): string =>
        template.replace(/\{\{(\w+)\}\}/g, (_, key) =>
          String(params[key] ?? "")
        );

      const url = resolve(config.url);

      // 构建 query 参数
      const searchParams = new URLSearchParams();
      if (config.query) {
        for (const [key, template] of Object.entries(config.query)) {
          searchParams.set(key, resolve(template));
        }
      }

      const fullUrl = searchParams.toString()
        ? `${url}?${searchParams.toString()}`
        : url;

      // 构建 headers
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...config.headers,
      };

      // 构建 body
      let body: string | undefined;
      if (config.method !== "GET" && config.body) {
        const bodyObj: Record<string, unknown> = {};
        for (const [key, template] of Object.entries(config.body)) {
          bodyObj[key] = resolve(template);
        }
        body = JSON.stringify(bodyObj);
      }

      const resp = await fetch(fullUrl, {
        method: config.method,
        headers,
        body,
      });

      const data = await resp.json();

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    } catch (err: any) {
      return {
        content: [
          {
            type: "text",
            text: `HTTP 代理请求失败: ${err.message}`,
          },
        ],
        isError: true,
      };
    }
  }
}

// 单例
export const skillRegistry = new SkillRegistry();
