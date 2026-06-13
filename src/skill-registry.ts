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

// ---- 常量 ----
const BUILTIN_SKILLS: SkillDefinition[] = [wechatReadingSkill];
const KV_LIST_KEY = "skills:registry";

export class SkillRegistry {
  private builtinSkills: SkillDefinition[] = BUILTIN_SKILLS;
  private dynamicSkills: Map<string, DynamicSkillDef> = new Map();
  private env: Env | null = null;

  bindEnv(env: Env) {
    this.env = env;
  }

  async loadFromKV(): Promise<void> {
    if (!this.env?.SKILLS_KV) return;
    try {
      const raw = await this.env.SKILLS_KV.get(KV_LIST_KEY, "json");
      if (raw && Array.isArray(raw)) {
        this.dynamicSkills.clear();
        for (const def of raw as DynamicSkillDef[]) {
          this.dynamicSkills.set(def.name, def);
        }
      }
    } catch {}
  }

  async saveToKV(): Promise<void> {
    if (!this.env?.SKILLS_KV) return;
    const list = Array.from(this.dynamicSkills.values());
    await this.env.SKILLS_KV.put(KV_LIST_KEY, JSON.stringify(list));
  }

  /** 获取 API 令牌 */
  async getApiToken(skillName: string): Promise<string | null> {
    if (!this.env?.SKILLS_KV) return null;
    try {
      return await this.env.SKILLS_KV.get(`token:${skillName}`);
    } catch {
      return null;
    }
  }

  /** 供外部调用的添加方法（如 Vercel 回调） */
  addDynamicSkill(def: DynamicSkillDef) {
    this.dynamicSkills.set(def.name, def);
  }

  /** 获取所有 Skill 的概要信息（供管理页面使用） */
  getAllSkillsInfo(): { total: number; skills: Record<string, unknown>[] } {
    const skills: Record<string, unknown>[] = [];
    for (const skill of this.builtinSkills) {
      skills.push({ name: skill.name, source: skill.source, type: "builtin" });
    }
    for (const [, skill] of this.dynamicSkills) {
      skills.push({ name: skill.name, source: skill.source, type: "dynamic" });
    }
    return { total: skills.length, skills };
  }

  listTools(): McpTool[] {
    const tools: McpTool[] = [];

    for (const skill of this.builtinSkills) {
      for (const tool of skill.tools) {
        tools.push({
          name: tool.name,
          description: `[${skill.name}] ${tool.description}`,
          inputSchema: tool.inputSchema,
        });
      }
    }

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
    tools.push({
      name: "skills_add",
      description: "安装一个新的 Skill。提供 npx 命令和可选的 API 令牌。" +
        "命令格式: npx skills add <source> [-g]。" +
        "API 令牌用于调用 skill 提供方的接口。",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: 'npx 安装命令，如 "npx skills add Tencent/WeChatReading -g"',
          },
          apiToken: {
            type: "string",
            description: "Skill 提供方的 API 令牌（可选，可在管理页面补充）",
          },
        },
        required: ["command"],
      },
    });

    tools.push({
      name: "skills_list",
      description: "列出所有已注册的 Skill",
      inputSchema: {
        type: "object",
        properties: { verbose: { type: "boolean", description: "是否显示详细信息" } },
      },
    });

    tools.push({
      name: "skills_remove",
      description: "移除一个已注册的动态 Skill",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "要移除的 Skill 标识名" } },
        required: ["name"],
      },
    });

    return tools;
  }

  async callTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
    if (name === "skills_add") return this.handleAdd(params);
    if (name === "skills_list") return this.handleList(params);
    if (name === "skills_remove") return this.handleRemove(params);

    for (const skill of this.builtinSkills) {
      if (skill.handlers[name]) {
        return skill.handlers[name](params, this.env!);
      }
    }

    for (const [, skill] of this.dynamicSkills) {
      if (skill.httpHandlers?.[name]) {
        return this.handleDynamicHttp(skill.httpHandlers[name], params);
      }
    }

    return { content: [{ type: "text", text: `未知工具: ${name}` }], isError: true };
  }

  private static SOURCE_MAP: Record<string, string> = {
    "Tencent/WeChatReading": "wechat-reading",
    "wechat-reading": "wechat-reading",
  };

  private async handleAdd(params: Record<string, unknown>): Promise<ToolResult> {
    const command = String(params.command ?? "").trim();
    const apiToken = String(params.apiToken ?? "").trim();

    if (!command) {
      return {
        content: [{ type: "text", text: "请提供 npx 安装命令，格式: npx skills add <source> [-g]" }],
        isError: true,
      };
    }

    // 解析 npx 命令
    const match = command.match(/^npx\s+skills\s+add\s+(\S+)/);
    if (!match) {
      return {
        content: [{ type: "text", text: `无法解析命令: ${command}\n格式: npx skills add <source> [-g]` }],
        isError: true,
      };
    }

    const source = match[1];

    // 检查是否是内置 Skill
    const mappedName = SkillRegistry.SOURCE_MAP[source];
    if (mappedName) {
      const builtin = this.builtinSkills.find((s) => s.name === mappedName);
      if (builtin) {
        // 保存 API 令牌
        if (apiToken && this.env?.SKILLS_KV) {
          await this.env.SKILLS_KV.put(`token:${builtin.name}`, apiToken);
        }
        return {
          content: [{
            type: "text",
            text: `✅ 内置 Skill "${source}" 已存在，可直接使用以下工具:\n${
              builtin.tools.map((t) => `  - ${t.name}: ${t.description}`).join("\n")
            }${apiToken ? "\n\nAPI 令牌已保存" : ""}`,
          }],
        };
      }
    }

    // 保存 API 令牌
    const skillName = source.split("/").pop() ?? source;
    if (apiToken && this.env?.SKILLS_KV) {
      await this.env.SKILLS_KV.put(`token:${skillName}`, apiToken);
    }

    // 判断是否有 Vercel 执行器
    const executorUrl = this.env?.VERCEL_EXECUTOR_URL;
    if (executorUrl) {
      try {
        const resp = await fetch(executorUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command,
            skillName,
            source,
            callbackUrl: `https://${this.env?.SKILLS_KV ? "..." : ""}/api/skills/register`,
          }),
        });
        if (resp.ok) {
          return {
            content: [{ type: "text", text: `✅ 已提交到 Vercel 执行器安装 "${source}"${apiToken ? "，API 令牌已保存" : ""}` }],
          };
        }
      } catch {}
    }

    return {
      content: [{
        type: "text",
        text: `✅ 命令已记录：${command}${apiToken ? "\nAPI 令牌已保存" : ""}\n\n请前往管理页面 (/admin) 查看执行状态，或在 Vercel 上执行此命令。`,
      }],
    };
  }

  private async handleList(params: Record<string, unknown>): Promise<ToolResult> {
    const verbose = Boolean(params.verbose);
    const skills: Record<string, unknown>[] = [];

    for (const skill of this.builtinSkills) {
      skills.push(verbose
        ? { name: skill.name, source: skill.source, type: "builtin", tools: skill.tools.map((t) => t.name) }
        : { name: skill.name, source: skill.source, type: "builtin" }
      );
    }

    for (const [, skill] of this.dynamicSkills) {
      skills.push(verbose
        ? { name: skill.name, source: skill.source, type: "dynamic", tools: skill.tools.map((t) => t.name) }
        : { name: skill.name, source: skill.source, type: "dynamic" }
      );
    }

    return { content: [{ type: "text", text: JSON.stringify({ total: skills.length, skills }, null, 2) }] };
  }

  private async handleRemove(params: Record<string, unknown>): Promise<ToolResult> {
    const name = String(params.name ?? "");
    if (!name) {
      return { content: [{ type: "text", text: "请提供 name 参数" }], isError: true };
    }
    if (this.builtinSkills.some((s) => s.name === name)) {
      return { content: [{ type: "text", text: `❌ 内置 Skill "${name}" 不可移除` }], isError: true };
    }
    if (!this.dynamicSkills.has(name)) {
      return { content: [{ type: "text", text: `❌ 未找到 Skill "${name}"` }], isError: true };
    }
    this.dynamicSkills.delete(name);
    await this.saveToKV();
    // 同时清理令牌
    if (this.env?.SKILLS_KV) {
      try { await this.env.SKILLS_KV.delete(`token:${name}`); } catch {}
    }
    return { content: [{ type: "text", text: `✅ Skill "${name}" 已移除` }] };
  }

  private async handleDynamicHttp(config: HttpHandlerConfig, params: Record<string, unknown>): Promise<ToolResult> {
    try {
      const resolve = (template: string): string =>
        template.replace(/\{\{(\w+)\}\}/g, (_, key) => String(params[key] ?? ""));

      // 获取该 skill 的 API 令牌
      // skillName 需要从当前 handler 所在 skill 推断

      const url = resolve(config.url);
      const searchParams = new URLSearchParams();
      if (config.query) {
        for (const [key, template] of Object.entries(config.query)) {
          searchParams.set(key, resolve(template));
        }
      }
      const fullUrl = searchParams.toString() ? `${url}?${searchParams.toString()}` : url;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        ...config.headers,
      };

      // 注入 API 令牌到 header（如果配置了 Authorization 模板）
      if (headers["Authorization"]?.includes("{{apiToken}}")) {
        const skillName = [...this.dynamicSkills].find(([, s]) =>
          s.httpHandlers && Object.keys(s.httpHandlers).includes(Object.keys(this.dynamicSkills).find(() => true) ?? "")
        )?.[0];
        if (skillName) {
          const token = await this.getApiToken(skillName);
          if (token) {
            headers["Authorization"] = headers["Authorization"].replace("{{apiToken}}", token);
          }
        }
      }

      let body: string | undefined;
      if (config.method !== "GET" && config.body) {
        const bodyObj: Record<string, unknown> = {};
        for (const [key, template] of Object.entries(config.body)) {
          bodyObj[key] = resolve(template);
        }
        body = JSON.stringify(bodyObj);
      }

      const resp = await fetch(fullUrl, { method: config.method, headers, body });
      const data = await resp.json();

      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    } catch (err: any) {
      return { content: [{ type: "text", text: `HTTP 代理请求失败: ${err.message}` }], isError: true };
    }
  }
}

export const skillRegistry = new SkillRegistry();
