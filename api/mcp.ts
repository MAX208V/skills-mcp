// ============================================================
//  Vercel Serverless Function 适配器
//  文件位置: api/mcp.ts
// ============================================================

// Vercel Node.js Runtime 适配
// 注意：Vercel 没有原生 KV，这里使用内存 Map 替代
// 生产环境建议接入 Redis / Upstash Redis / Vercel KV

import type {
  Env,
  JsonRpcRequest,
  JsonRpcResponse,
  ToolResult,
  DynamicSkillDef,
  SkillToolDef,
  HttpHandlerConfig,
  McpTool,
} from "../src/types";

// ---- Vercel KV 模拟（生产环境请替换为 @vercel/kv） ----
const memoryKV = new Map<string, string>();

const fakeKV: KVNamespace = {
  get: async (key: string, type?: string) => {
    const val = memoryKV.get(key);
    if (type === "json" && val) return JSON.parse(val);
    return val ?? null;
  },
  put: async (key: string, value: string) => {
    memoryKV.set(key, value);
  },
  delete: async (key: string) => {
    memoryKV.delete(key);
  },
  list: async () => ({ list_complete: true, keys: [] }),
} as unknown as KVNamespace;

// ---- 内联简化版 MCP 服务器（与 src/mcp-server.ts 逻辑一致） ----

import { wechatReadingSkill } from "../src/skills/wechat-reading";

const BUILTIN_SKILLS = [wechatReadingSkill];
const KV_LIST_KEY = "skills:registry";
const MCP_VERSION = "2025-03-26";
const sessions = new Map<string, { createdAt: number }>();

// Skill Registry（简化版）
const dynamicSkills = new Map<string, DynamicSkillDef>();

const SOURCE_MAP: Record<string, string> = {
  "Tencent/WeChatReading": "wechat-reading",
  "wechat-reading": "wechat-reading",
};

async function loadDynamicSkills() {
  const raw = await fakeKV.get(KV_LIST_KEY, "json");
  if (raw && Array.isArray(raw)) {
    dynamicSkills.clear();
    for (const def of raw as DynamicSkillDef[]) {
      dynamicSkills.set(def.name, def);
    }
  }
}

async function saveDynamicSkills() {
  await fakeKV.put(KV_LIST_KEY, JSON.stringify(Array.from(dynamicSkills.values())));
}

function listTools(): McpTool[] {
  const tools: McpTool[] = [];
  for (const skill of BUILTIN_SKILLS) {
    for (const tool of skill.tools) {
      tools.push({
        name: tool.name,
        description: `[${skill.name}] ${tool.description}`,
        inputSchema: tool.inputSchema,
      });
    }
  }
  for (const [, skill] of dynamicSkills) {
    for (const tool of skill.tools) {
      tools.push({
        name: tool.name,
        description: `[${skill.name}] ${tool.description}`,
        inputSchema: tool.inputSchema,
      });
    }
  }
  tools.push(
    {
      name: "skills_add",
      description: "添加一个新的 Skill 到注册中心",
      inputSchema: {
        type: "object",
        properties: {
          source: { type: "string", description: 'Skill 来源，如 "Tencent/WeChatReading"' },
          definition: { type: "object", description: "自定义 Skill 定义（可选）" },
        },
        required: ["source"],
      },
    },
    {
      name: "skills_list",
      description: "列出所有已注册的 Skill",
      inputSchema: { type: "object", properties: {} },
    },
    {
      name: "skills_remove",
      description: "移除一个已注册的动态 Skill",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    }
  );
  return tools;
}

async function callTool(name: string, params: Record<string, unknown>): Promise<ToolResult> {
  const env: Env = { SKILLS_KV: fakeKV };

  // 管理工具
  if (name === "skills_add") {
    const source = String(params.source ?? "");
    const definition = params.definition as DynamicSkillDef | undefined;
    const mapped = SOURCE_MAP[source];
    if (mapped) {
      const builtin = BUILTIN_SKILLS.find((s) => s.name === mapped);
      if (builtin) {
        return {
          content: [{ type: "text", text: `✅ 内置 Skill "${source}" 已存在，可直接使用:\n${builtin.tools.map((t) => `  - ${t.name}`).join("\n")}` }],
        };
      }
    }
    if (definition) {
      const def: DynamicSkillDef = {
        name: definition.name ?? source.split("/").pop() ?? source,
        source,
        description: definition.description ?? `Dynamic skill from ${source}`,
        tools: definition.tools ?? [],
        httpHandlers: definition.httpHandlers,
      };
      dynamicSkills.set(def.name, def);
      await saveDynamicSkills();
      return {
        content: [{ type: "text", text: `✅ 动态 Skill "${def.name}" 添加成功！` }],
      };
    }
    return {
      content: [{ type: "text", text: `⚠️ 未找到 "${source}"，请提供 definition` }],
      isError: true,
    };
  }

  if (name === "skills_list") {
    const skills = [
      ...BUILTIN_SKILLS.map((s) => ({ name: s.name, source: s.source, type: "builtin" })),
      ...Array.from(dynamicSkills.values()).map((s) => ({ name: s.name, source: s.source, type: "dynamic" })),
    ];
    return { content: [{ type: "text", text: JSON.stringify({ total: skills.length, skills }, null, 2) }] };
  }

  if (name === "skills_remove") {
    const name_ = String(params.name ?? "");
    if (BUILTIN_SKILLS.some((s) => s.name === name_)) {
      return { content: [{ type: "text", text: `❌ 内置 Skill 不可移除` }], isError: true };
    }
    dynamicSkills.delete(name_);
    await saveDynamicSkills();
    return { content: [{ type: "text", text: `✅ Skill "${name_}" 已移除` }] };
  }

  // 内置处理器
  for (const skill of BUILTIN_SKILLS) {
    if (skill.handlers[name]) {
      return skill.handlers[name](params, env);
    }
  }

  return { content: [{ type: "text", text: `未知工具: ${name}` }], isError: true };
}

// ---- Vercel Handler ----

export default async function handler(req: Request): Promise<Response> {
  const cors: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };

  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: cors });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }), {
      status: 400,
      headers: { "Content-Type": "application/json", ...cors },
    });
  }

  const isBatch = Array.isArray(body);
  const requests: JsonRpcRequest[] = isBatch ? body : [body];
  const responses: JsonRpcResponse[] = [];

  await loadDynamicSkills();

  for (const rpcReq of requests) {
    if (!rpcReq || rpcReq.jsonrpc !== "2.0") {
      responses.push({ jsonrpc: "2.0", id: rpcReq?.id ?? null, error: { code: -32600, message: "Invalid Request" } });
      continue;
    }

    const { id, method, params } = rpcReq;

    if (id === undefined || id === null) continue; // notification

    try {
      let result: any;
      switch (method) {
        case "initialize":
          const sid = crypto.randomUUID();
          sessions.set(sid, { createdAt: Date.now() });
          result = {
            protocolVersion: MCP_VERSION,
            capabilities: { tools: { listChanged: true } },
            serverInfo: { name: "skills-mcp", version: "1.0.0" },
            _meta: { sessionId: sid },
          };
          break;
        case "ping":
          result = {};
          break;
        case "tools/list":
          result = { tools: listTools() };
          break;
        case "tools/call":
          result = await callTool(String((params as any)?.name ?? ""), ((params as any)?.arguments ?? {}) as Record<string, unknown>);
          break;
        default:
          responses.push({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
          continue;
      }

      const sessionId = result?._meta?.sessionId;
      if (sessionId) delete result._meta;

      const resp: JsonRpcResponse = { jsonrpc: "2.0", id, result };
      if (sessionId) {
        // 通过 header 返回 session ID
        const respBody = JSON.stringify(resp);
        return new Response(respBody, {
          status: 200,
          headers: {
            "Content-Type": "application/json",
            "Mcp-Session-Id": sessionId,
            ...cors,
          },
        });
      }
      responses.push(resp);
    } catch (err: any) {
      responses.push({ jsonrpc: "2.0", id, error: { code: -32603, message: err.message } });
    }
  }

  if (responses.length === 0) {
    return new Response(null, { status: 202, headers: cors });
  }

  return new Response(
    isBatch ? JSON.stringify(responses) : JSON.stringify(responses[0]),
    { status: 200, headers: { "Content-Type": "application/json", ...cors } }
  );
}

export const config = {
  path: "/api/mcp",
};
