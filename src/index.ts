// ============================================================
//  Cloudflare Worker 入口
// ============================================================

import { handleMcpRequest } from "./mcp-server";
import { skillRegistry } from "./skill-registry";
import type { Env } from "./types";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // ---- MCP 端点 ----
    if (url.pathname === "/mcp" || url.pathname === "/mcp/") {
      return handleMcpRequest(request, env);
    }

    // ---- 健康检查 / 首页 ----
    if (url.pathname === "/" && request.method === "GET") {
      return new Response(
        JSON.stringify({
          name: "Skills MCP Server",
          version: "1.0.0",
          protocolVersion: "2025-03-26",
          description: "可扩展的 Skills 基座 MCP Server",
          endpoints: {
            mcp: "/mcp",
            admin: "/admin",
            health: "/",
          },
        }, null, 2),
        { headers: { "Content-Type": "application/json", ...cors } }
      );
    }

    // ---- Web 管理页面 ----
    if (url.pathname === "/admin" && request.method === "GET") {
      return serveAdminPage(env);
    }

    // ---- API: 获取已注册 Skills ----
    if (url.pathname === "/api/skills" && request.method === "GET") {
      skillRegistry.bindEnv(env);
      await skillRegistry.loadFromKV();
      return new Response(
        JSON.stringify(skillRegistry.getAllSkillsInfo(), null, 2),
        { headers: { "Content-Type": "application/json", ...cors } }
      );
    }

    // ---- API: 提交 npx 命令 + API 令牌 ----
    if (url.pathname === "/api/skills/submit" && request.method === "POST") {
      return handleSkillSubmit(request, env);
    }

    // ---- API: Vercel 回调（写入 npx 执行结果） ----
    if (url.pathname === "/api/skills/register" && request.method === "POST") {
      return handleSkillRegister(request, env);
    }

    // ---- 404 ----
    return new Response("Not Found", { status: 404, headers: cors });
  },
};

/** 处理 npx 命令提交 */
async function handleSkillSubmit(request: Request, env: Env): Promise<Response> {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  try {
    const body: any = await request.json();
    const command = String(body.command ?? "").trim();
    const apiToken = String(body.apiToken ?? "").trim();

    if (!command) {
      return new Response(JSON.stringify({ error: "command 不能为空" }), {
        status: 400, headers: { "Content-Type": "application/json", ...cors },
      });
    }

    // 解析 npx 命令，提取 source
    const match = command.match(/^npx\s+skills\s+add\s+(\S+)/);
    if (!match) {
      return new Response(JSON.stringify({ error: "无法解析 npx 命令，格式: npx skills add <source> [-g]" }), {
        status: 400, headers: { "Content-Type": "application/json", ...cors },
      });
    }

    const source = match[1];
    const skillName = source.split("/").pop() ?? source;

    // 存储 API 令牌到 KV
    if (apiToken && env.SKILLS_KV) {
      await env.SKILLS_KV.put(`token:${skillName}`, apiToken);
    }

    // 如果配置了 Vercel 执行器，自动转发
    if (env.VERCEL_EXECUTOR_URL) {
      const vercelResp = await fetch(env.VERCEL_EXECUTOR_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ command, skillName, source, callbackUrl: `${request.url}/register` }),
      });

      if (vercelResp.ok) {
        const data = await vercelResp.json();
        return new Response(JSON.stringify({
          message: `✅ 已提交到 Vercel 执行器执行`,
          skillName,
          source,
          executorResponse: data,
        }, null, 2), {
          headers: { "Content-Type": "application/json", ...cors },
        });
      }
    }

    // 未配置 Vercel 执行器，返回指引
    return new Response(JSON.stringify({
      message: `✅ API 令牌已保存，请在 Vercel 上执行以下命令完成安装：`,
      command,
      skillName,
      source,
      hint: `在 Vercel npx-executor 项目中执行: ${command}`,
    }, null, 2), {
      headers: { "Content-Type": "application/json", ...cors },
    });

  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json", ...cors },
    });
  }
}

/** 处理 Vercel 回调（写入 npx 解析结果到 KV） */
async function handleSkillRegister(request: Request, env: Env): Promise<Response> {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };

  try {
    const body: any = await request.json();
    const { name, source, description, tools, httpHandlers } = body;

    if (!name || !source) {
      return new Response(JSON.stringify({ error: "name 和 source 不能为空" }), {
        status: 400, headers: { "Content-Type": "application/json", ...cors },
      });
    }

    // 读取已有 dynamic skills
    skillRegistry.bindEnv(env);
    await skillRegistry.loadFromKV();

    // 添加新 skill 定义
    skillRegistry.addDynamicSkill({
      name,
      source,
      description: description ?? `Skill from ${source}`,
      tools: tools ?? [],
      httpHandlers,
    });

    await skillRegistry.saveToKV();

    return new Response(JSON.stringify({ success: true, name, source }), {
      headers: { "Content-Type": "application/json", ...cors },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500, headers: { "Content-Type": "application/json", ...cors },
    });
  }
}

/** 提供 Web 管理页面 */
async function serveAdminPage(env: Env): Promise<Response> {
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Skills MCP 管理</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f5f5f5; color: #333; }
    .container { max-width: 800px; margin: 0 auto; padding: 24px; }
    h1 { font-size: 24px; margin-bottom: 24px; }
    .card { background: #fff; border-radius: 8px; padding: 20px; margin-bottom: 20px; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }
    .card h2 { font-size: 18px; margin-bottom: 16px; }
    label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 6px; }
    input, textarea { width: 100%; padding: 10px 12px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; margin-bottom: 16px; }
    textarea { font-family: monospace; min-height: 60px; }
    button { background: #2563eb; color: #fff; border: none; padding: 10px 20px; border-radius: 6px; font-size: 14px; cursor: pointer; }
    button:hover { background: #1d4ed8; }
    button:disabled { opacity: 0.6; cursor: not-allowed; }
    .skill-item { display: flex; justify-content: space-between; align-items: center; padding: 12px 0; border-bottom: 1px solid #eee; }
    .skill-item:last-child { border-bottom: none; }
    .skill-name { font-weight: 600; }
    .skill-source { font-size: 12px; color: #666; }
    .skill-type { font-size: 12px; padding: 2px 8px; border-radius: 10px; }
    .type-builtin { background: #dbeafe; color: #1d4ed8; }
    .type-dynamic { background: #d1fae5; color: #059669; }
    .badge { font-size: 12px; padding: 2px 8px; border-radius: 10px; background: #fef3c7; color: #d97706; }
    .toast { position: fixed; bottom: 24px; right: 24px; padding: 12px 20px; border-radius: 6px; color: #fff; font-size: 14px; display: none; }
    .toast.success { background: #059669; display: block; }
    .toast.error { background: #dc2626; display: block; }
    .empty { color: #999; text-align: center; padding: 24px; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🛠 Skills MCP 管理</h1>

    <div class="card">
      <h2>📦 已注册 Skills</h2>
      <div id="skills-list"><p class="empty">加载中...</p></div>
    </div>

    <div class="card">
      <h2>➕ 添加新 Skill</h2>
      <form id="submit-form">
        <label for="command">npx 安装命令</label>
        <textarea id="command" placeholder="npx skills add Tencent/WeChatReading -g" required></textarea>

        <label for="apiToken">Skill API 令牌</label>
        <input type="password" id="apiToken" placeholder="skill 提供方的 API 令牌（可选）" />

        <button type="submit" id="submit-btn">提交</button>
      </form>
    </div>

    <div class="card">
      <h2>⚙️ 环境信息</h2>
      <p style="font-size:14px;color:#666;">
        Vercel 执行器:
        <code id="vercel-status">${env.VERCEL_EXECUTOR_URL ? `已配置 (${env.VERCEL_EXECUTOR_URL})` : "未配置"}</code>
      </p>
      <p style="font-size:14px;color:#666;margin-top:8px;">
        MCP 端点鉴权:
        <code id="auth-status">${env.MCP_AUTH_TOKEN ? "✅ 已启用" : "⚠️ 未配置"}</code>
      </p>
    </div>
  </div>

  <div id="toast" class="toast"></div>

  <script>
    async function loadSkills() {
      const el = document.getElementById("skills-list");
      try {
        const resp = await fetch("/api/skills");
        const data = await resp.json();
        if (!data.skills || data.skills.length === 0) {
          el.innerHTML = '<p class="empty">暂无已注册的 Skill</p>';
          return;
        }
        el.innerHTML = data.skills.map(s => \`
          <div class="skill-item">
            <div>
              <div class="skill-name">\${s.name}</div>
              <div class="skill-source">\${s.source}</div>
            </div>
            <div>
              <span class="skill-type \${s.type === "builtin" ? "type-builtin" : "type-dynamic"}">\${s.type}</span>
            </div>
          </div>
        \`).join("");
      } catch (e) {
        el.innerHTML = '<p class="empty" style="color:#dc2626;">加载失败</p>';
      }
    }

    function showToast(msg, type) {
      const el = document.getElementById("toast");
      el.textContent = msg;
      el.className = "toast " + type;
      setTimeout(() => { el.className = "toast"; }, 4000);
    }

    document.getElementById("submit-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = document.getElementById("submit-btn");
      btn.disabled = true;
      btn.textContent = "提交中...";

      try {
        const resp = await fetch("/api/skills/submit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            command: document.getElementById("command").value.trim(),
            apiToken: document.getElementById("apiToken").value.trim(),
          }),
        });
        const data = await resp.json();
        if (resp.ok) {
          showToast("✅ " + data.message, "success");
          document.getElementById("command").value = "";
          document.getElementById("apiToken").value = "";
          loadSkills();
        } else {
          showToast("❌ " + (data.error || "提交失败"), "error");
        }
      } catch (e) {
        showToast("❌ 网络错误", "error");
      } finally {
        btn.disabled = false;
        btn.textContent = "提交";
      }
    });

    loadSkills();
  </script>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8" },
  });
}
