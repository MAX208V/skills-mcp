// ============================================================
//  MCP 协议服务器 - 实现 Streamable HTTP 传输
//  MCP 规范版本: 2025-03-26
// ============================================================

import type {
  Env,
  JsonRpcRequest,
  JsonRpcResponse,
  ToolResult,
} from "./types";
import { skillRegistry } from "./skill-registry";

// ---- 常量 ----

const MCP_VERSION = "2025-03-26";
const SERVER_NAME = "skills-mcp";
const SERVER_VERSION = "1.0.0";

// ---- JSON-RPC 错误码 ----

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

// ---- Session 管理 ----

const sessions = new Map<string, { createdAt: number }>();

function generateSessionId(): string {
  return crypto.randomUUID();
}

// ---- MCP 方法处理器 ----

async function handleInitialize(
  id: string | number | null,
  params: Record<string, unknown>
): Promise<JsonRpcResponse> {
  const sessionId = generateSessionId();
  sessions.set(sessionId, { createdAt: Date.now() });

  return {
    jsonrpc: "2.0",
    id,
    result: {
      protocolVersion: MCP_VERSION,
      capabilities: {
        tools: {
          listChanged: true,
        },
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      _meta: {
        sessionId,
      },
    },
  };
}

async function handleToolsList(id: string | number | null): Promise<JsonRpcResponse> {
  await skillRegistry.loadFromKV();
  const tools = skillRegistry.listTools();
  return { jsonrpc: "2.0", id, result: { tools } };
}

async function handleToolsCall(
  id: string | number | null,
  params: Record<string, unknown>
): Promise<JsonRpcResponse> {
  const toolName = String(params.name ?? "");
  const toolArgs = (params.arguments as Record<string, unknown>) ?? {};

  if (!toolName) {
    return { jsonrpc: "2.0", id, error: { code: INVALID_PARAMS, message: "Missing tool name" } };
  }

  try {
    const result: ToolResult = await skillRegistry.callTool(toolName, toolArgs);
    return { jsonrpc: "2.0", id, result };
  } catch (err: any) {
    return {
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: `Tool execution error: ${err.message}` }], isError: true },
    };
  }
}

async function handlePing(id: string | number | null): Promise<JsonRpcResponse> {
  return { jsonrpc: "2.0", id, result: {} };
}

// ---- 请求分发 ----

async function dispatch(request: JsonRpcRequest, env: Env): Promise<JsonRpcResponse> {
  const { id, method, params } = request;
  skillRegistry.bindEnv(env);

  switch (method) {
    case "initialize":
      return handleInitialize(id ?? null, (params as Record<string, unknown>) ?? {});
    case "notifications/initialized":
      return { jsonrpc: "2.0", id: id ?? null, result: {} };
    case "ping":
      return handlePing(id ?? null);
    case "tools/list":
      return handleToolsList(id ?? null);
    case "tools/call":
      return handleToolsCall(id ?? null, (params as Record<string, unknown>) ?? {});
    default:
      return { jsonrpc: "2.0", id: id ?? null, error: { code: METHOD_NOT_FOUND, message: `Method not found: ${method}` } };
  }
}

// ---- HTTP 处理 ----

function makeErrorResponse(id: string | number | null, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id, Authorization",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

export async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const cors = corsHeaders();

  // ---- MCP 端点鉴权 ----
  const authToken = env.MCP_AUTH_TOKEN;
  if (authToken) {
    const authHeader = request.headers.get("Authorization") ?? "";
    if (!authHeader.startsWith("Bearer ") || authHeader.slice(7) !== authToken) {
      return new Response("Unauthorized", { status: 401, headers: cors });
    }
  }

  // ---- CORS 预检 ----
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  // ---- GET：SSE 连接 ----
  if (request.method === "GET") {
    const sessionId = request.headers.get("Mcp-Session-Id");
    if (!sessionId || !sessions.has(sessionId)) {
      return new Response("Session not found", { status: 404, headers: cors });
    }

    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const heartbeat = setInterval(async () => {
      try { await writer.write(encoder.encode(": heartbeat\n\n")); } catch { clearInterval(heartbeat); }
    }, 15000);

    setTimeout(async () => {
      clearInterval(heartbeat);
      try { await writer.close(); } catch {}
    }, 5 * 60 * 1000);

    return new Response(readable, {
      headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive", ...cors },
    });
  }

  // ---- DELETE：关闭 Session ----
  if (request.method === "DELETE") {
    const sessionId = request.headers.get("Mcp-Session-Id");
    if (sessionId) sessions.delete(sessionId);
    return new Response(null, { status: 204, headers: cors });
  }

  // ---- POST ----
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: cors });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify(makeErrorResponse(null, PARSE_ERROR, "Parse error")), {
      status: 400, headers: { "Content-Type": "application/json", ...cors },
    });
  }

  const isBatch = Array.isArray(body);
  const requests: JsonRpcRequest[] = isBatch ? body : [body];
  const responses: JsonRpcResponse[] = [];

  for (const req of requests) {
    if (!req || req.jsonrpc !== "2.0") {
      responses.push(makeErrorResponse(req?.id ?? null, INVALID_REQUEST, "Invalid Request"));
      continue;
    }
    if (req.id === undefined || req.id === null) {
      dispatch(req, env).catch(() => {});
      continue;
    }
    try {
      const resp = await dispatch(req, env);
      responses.push(resp);
    } catch (err: any) {
      responses.push(makeErrorResponse(req.id, INTERNAL_ERROR, err.message ?? "Internal error"));
    }
  }

  if (responses.length === 0) {
    return new Response(null, { status: 202, headers: cors });
  }

  const sessionId = request.headers.get("Mcp-Session-Id") ??
    (responses.find((r) => r.result?._meta?.sessionId)?.result?._meta?.sessionId);

  const responseHeaders: Record<string, string> = { "Content-Type": "application/json", ...cors };
  if (sessionId) responseHeaders["Mcp-Session-Id"] = sessionId;

  for (const resp of responses) {
    if (resp.result?._meta?.sessionId) {
      delete resp.result._meta.sessionId;
      if (Object.keys(resp.result._meta).length === 0) delete resp.result._meta;
    }
  }

  return new Response(isBatch ? JSON.stringify(responses) : JSON.stringify(responses[0]), {
    status: 200, headers: responseHeaders,
  });
}
