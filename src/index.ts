// ============================================================
//  Cloudflare Worker 入口
// ============================================================

import { handleMcpRequest } from "./mcp-server";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // ---- 健康检查 / 首页 ----
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        JSON.stringify(
          {
            name: "Skills MCP Server",
            version: "1.0.0",
            protocolVersion: "2025-03-26",
            description: "可扩展的 Skills 基座 MCP Server",
            endpoints: {
              mcp: "/mcp",
              health: "/",
            },
            builtinSkills: ["wechat-reading (Tencent/WeChatReading)"],
          },
          null,
          2
        ),
        {
          headers: { "Content-Type": "application/json" },
        }
      );
    }

    // ---- MCP 端点 ----
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      return handleMcpRequest(request, env);
    }

    // ---- 404 ----
    return new Response("Not Found", { status: 404 });
  },
};
