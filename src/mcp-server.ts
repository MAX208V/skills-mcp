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
          listChanged: true, // 支持工具列表变更通知
        },
      },
      serverInfo: {
        name: SERVER_NAME,
        version: SERVER_VERSION,
      },
      // 自定义：返回 session ID
      _meta: {
        sessionId,
      },
    },
  };
}

async function handleToolsList(
  id: string | number | null
): Promise<JsonRpcResponse> {
  await skillRegistry.loadFromKV();
  const tools = skillRegistry.listTools();

  return {
    jsonrpc: "2.0",
    id,
    result: { tools },
  };
}

async function handleToolsCall(
  id: string | number | null,
  params: Record<string, unknown>
): Promise<JsonRpcResponse> {
  const toolName = String(params.name ?? "");
  const toolArgs = (params.arguments as Record<string, unknown>) ?? {};

  if (!toolName) {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: INVALID_PARAMS,
        message: "Missing tool name",
      },
    };
  }

  try {
    const result: ToolResult = await skillRegistry.callTool(toolName, toolArgs);
    return {
      jsonrpc: "2.0",
      id,
      result,
    };
  } catch (err: any) {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        content: [
          {
            type: "text",
            text: `Tool execution error: ${err.message}`,
          },
        ],
        isError: true,
      },
    };
  }
}

async function handlePing(
  id: string | number | null
): Promise<JsonRpcResponse> {
  return {
    jsonrpc: "2.0",
    id,
    result: {},
  };
}

// ---- 请求分发 ----

async function dispatch(request: JsonRpcRequest, env: Env): Promise<JsonRpcResponse> {
  const { id, method, params } = request;

  // 绑定环境
  skillRegistry.bindEnv(env);

  switch (method) {
    case "initialize":
      return handleInitialize(id ?? null, (params as Record<string, unknown>) ?? {});

    case "notifications/initialized":
      // 客户端通知，无需响应（但如果有 id，返回空结果）
      return { jsonrpc: "2.0", id: id ?? null, result: {} };

    case "ping":
      return handlePing(id ?? null);

    case "tools/list":
      return handleToolsList(id ?? null);

    case "tools/call":
      return handleToolsCall(id ?? null, (params as Record<string, unknown>) ?? {});

    default:
      return {
        jsonrpc: "2.0",
        id: id ?? null,
        error: {
          code: METHOD_NOT_FOUND,
          message: `Method not found: ${method}`,
        },
      };
  }
}

// ---- HTTP 处理 ----

function makeErrorResponse(
  id: string | number | null,
  code: number,
  message: string
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept, Mcp-Session-Id",
    "Access-Control-Expose-Headers": "Mcp-Session-Id",
  };
}

export async function handleMcpRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const cors = corsHeaders();

  // ---- CORS 预检 ----
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  // ---- GET：SSE 连接（用于服务端推送通知，简单实现） ----
  if (request.method === "GET") {
    const sessionId = request.headers.get("Mcp-Session-Id");
    if (!sessionId || !sessions.has(sessionId)) {
      return new Response("Session not found", { status: 404, headers: cors });
    }

    // 返回 SSE 流（保持连接，发送心跳）
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    // 心跳循环
    const heartbeat = setInterval(async () => {
      try {
        await writer.write(encoder.encode(": heartbeat\n\n"));
      } catch {
        clearInterval(heartbeat);
      }
    }, 15000);

    // 超时自动关闭（5分钟）
    setTimeout(async () => {
      clearInterval(heartbeat);
      try {
        await writer.close();
      } catch {}
    }, 5 * 60 * 1000);

    return new Response(readable, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        ...cors,
      },
    });
  }

  // ---- DELETE：关闭 Session ----
  if (request.method === "DELETE") {
    const sessionId = request.headers.get("Mcp-Session-Id");
    if (sessionId) {
      sessions.delete(sessionId);
    }
    return new Response(null, { status: 204, headers: cors });
  }

  // ---- POST：核心 MCP 请求处理 ----
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405, headers: cors });
  }

  // 解析请求体
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    const resp = makeErrorResponse(null, PARSE_ERROR, "Parse error");
    return new Response(JSON.stringify(resp), {
      status: 400,
      headers: { "Content-Type": "application/json", ...cors },
    });
  }

  // 处理批量请求
  const isBatch = Array.isArray(body);
  const requests: JsonRpcRequest[] = isBatch ? body : [body];

  const responses: JsonRpcResponse[] = [];

  for (const req of requests) {
    // 基本校验
    if (!req || req.jsonrpc !== "2.0") {
      responses.push(makeErrorResponse(req?.id ?? null, INVALID_REQUEST, "Invalid Request"));
      continue;
    }

    // 通知类消息（无 id）-> 202 Accepted
    if (req.id === undefined || req.id === null) {
      // 处理通知但不需要返回响应
      dispatch(req, env).catch(() => {});
      continue;
    }

    try {
      const resp = await dispatch(req, env);
      responses.push(resp);
    } catch (err: any) {
      responses.push(
        makeErrorResponse(req.id, INTERNAL_ERROR, err.message ?? "Internal error")
      );
    }
  }

  // 如果所有消息都是通知，返回 202
  if (responses.length === 0) {
    return new Response(null, { status: 202, headers: cors });
  }

  // 获取或生成 Session ID
  const sessionId = request.headers.get("Mcp-Session-Id") ?? 
    (responses.find((r) => r.result?._meta?.sessionId)?.result?._meta?.sessionId);

  const responseHeaders: Record<string, string> = {
    "Content-Type": "application/json",
    ...cors,
  };
  if (sessionId) {
    responseHeaders["Mcp-Session-Id"] = sessionId;
  }

  // 清除 _meta.sessionId（已放入 header）
  for (const resp of responses) {
    if (resp.result?._meta?.sessionId) {
      delete resp.result._meta.sessionId;
      if (Object.keys(resp.result._meta).length === 0) {
        delete resp.result._meta;
      }
    }
  }

  const responseBody = isBatch
    ? JSON.stringify(responses)
    : JSON.stringify(responses[0]);

  return new Response(responseBody, {
    status: 200,
    headers: responseHeaders,
  });
}
