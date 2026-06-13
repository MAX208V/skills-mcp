// ============================================================
//  类型定义 - Skills MCP 的核心类型
// ============================================================

/** Cloudflare Worker 环境变量绑定 */
export interface Env {
  SKILLS_KV: KVNamespace;
  WEREAD_COOKIE?: string;
  /** MCP 端点 Bearer Token 鉴权 */
  MCP_AUTH_TOKEN?: string;
  /** Vercel npx 执行器的 URL（可选，配置后自动转发 npx 命令） */
  VERCEL_EXECUTOR_URL?: string;
}

// ---- MCP 协议类型 ----

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// ---- Skill 类型 ----

/** 单个工具的输入 Schema */
export interface ToolInputSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
}

/** Skill 中暴露的工具定义 */
export interface SkillToolDef {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}

/** 工具执行结果 */
export interface ToolResult {
  content: Array<{
    type: "text" | "image" | "resource";
    text?: string;
    data?: string;
    mimeType?: string;
    uri?: string;
  }>;
  isError?: boolean;
}

/** 工具处理器函数 */
export type ToolHandler = (
  params: Record<string, unknown>,
  env: Env
) => Promise<ToolResult>;

/** Skill 定义（内置） */
export interface SkillDefinition {
  name: string;
  source: string;
  description: string;
  tools: SkillToolDef[];
  handlers: Record<string, ToolHandler>;
}

/** Skill 定义（动态 / KV 存储，无 code handler） */
export interface DynamicSkillDef {
  name: string;
  source: string;
  description: string;
  tools: SkillToolDef[];
  httpHandlers?: Record<string, HttpHandlerConfig>;
}

/** HTTP 代理处理器配置 */
export interface HttpHandlerConfig {
  url: string;
  method: "GET" | "POST" | "PUT" | "DELETE";
  headers?: Record<string, string>;
  query?: Record<string, string>;
  body?: Record<string, string>;
  responsePath?: string;
}

/** MCP 工具列表中展示的格式 */
export interface McpTool {
  name: string;
  description: string;
  inputSchema: ToolInputSchema;
}
