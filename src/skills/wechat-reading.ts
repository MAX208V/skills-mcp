// ============================================================
//  微信读书 Skill - 内置 Skill 示例
//  对应命令：npx skills add Tencent/WeChatReading -g
// ============================================================

import type { SkillDefinition, Env, ToolResult } from "../types";

/** 通用请求封装 */
async function wereadFetch(
  path: string,
  cookie: string,
  baseUrl: string,
  options: { method?: string; body?: unknown } = {}
): Promise<unknown> {
  const url = `${baseUrl}${path}`;
  const resp = await fetch(url, {
    method: options.method ?? "GET",
    headers: {
      "User-Agent":
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36",
      Cookie: cookie,
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!resp.ok) {
    throw new Error(`WeRead API error: ${resp.status} ${resp.statusText}`);
  }
  return resp.json();
}

/** 从搜索结果中提取关键信息 */
function extractBookInfo(book: any): Record<string, unknown> {
  return {
    bookId: book.bookId ?? "",
    title: book.title ?? "",
    author: book.author ?? "",
    cover: book.cover ?? "",
    intro: book.intro ?? "",
    category: book.category ?? "",
    publishTime: book.publishTime ?? "",
    rating: book.newRating ?? 0,
    readingCount: book.readingCount ?? 0,
  };
}

export const wechatReadingSkill: SkillDefinition = {
  name: "wechat-reading",
  source: "Tencent/WeChatReading",
  description: "微信读书 - 搜索书籍、查看详情、获取笔记与书评",

  tools: [
    {
      name: "wechat_reading_search",
      description: "在微信读书中搜索书籍",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "搜索关键词（书名、作者等）",
          },
          maxResults: {
            type: "number",
            description: "返回最大结果数，默认 10",
          },
        },
        required: ["query"],
      },
    },
    {
      name: "wechat_reading_book_detail",
      description: "获取微信读书中某本书的详细信息",
      inputSchema: {
        type: "object",
        properties: {
          bookId: {
            type: "string",
            description: "书籍 ID（从搜索结果获取）",
          },
        },
        required: ["bookId"],
      },
    },
    {
      name: "wechat_reading_book_notes",
      description: "获取微信读书中某本书的热门标注/笔记",
      inputSchema: {
        type: "object",
        properties: {
          bookId: {
            type: "string",
            description: "书籍 ID",
          },
          limit: {
            type: "number",
            description: "返回条数上限，默认 20",
          },
        },
        required: ["bookId"],
      },
    },
    {
      name: "wechat_reading_book_reviews",
      description: "获取微信读书中某本书的书评",
      inputSchema: {
        type: "object",
        properties: {
          bookId: {
            type: "string",
            description: "书籍 ID",
          },
          limit: {
            type: "number",
            description: "返回条数上限，默认 10",
          },
        },
        required: ["bookId"],
      },
    },
    {
      name: "wechat_reading_recommend",
      description: "获取微信读书的推荐书单",
      inputSchema: {
        type: "object",
        properties: {
          category: {
            type: "string",
            description: "分类名称（可选，如 '文学', '科技'）",
          },
        },
        required: [],
      },
    },
  ],

  handlers: {
    // ---- 搜索书籍 ----
    wechat_reading_search: async (params, env: Env) => {
      const query = String(params.query ?? "");
      const maxResults = Number(params.maxResults ?? 10);
      const baseUrl = env.WEREAD_BASE_URL ?? "https://weread.qq.com";

      if (!query.trim()) {
        return {
          content: [{ type: "text", text: "请提供搜索关键词" }],
          isError: true,
        };
      }

      const cookie = env.WEREAD_COOKIE ?? "";
      if (!cookie) {
        return {
          content: [
            {
              type: "text",
              text: "⚠️ 未配置 WEREAD_COOKIE。请在 wrangler.toml 或 wrangler secret 中设置微信读书 Cookie。\n获取方式：登录 weread.qq.com → 复制 Cookie",
            },
          ],
          isError: true,
        };
      }

      try {
        const data = (await wereadFetch(
          `/api/web/search?query=${encodeURIComponent(query)}`,
          cookie,
          baseUrl
        )) as any;

        const books = (data?.books ?? data?.results ?? [])
          .slice(0, maxResults)
          .map(extractBookInfo);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  query,
                  total: books.length,
                  books,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text",
              text: `搜索失败: ${err.message}`,
            },
          ],
          isError: true,
        };
      }
    },

    // ---- 书籍详情 ----
    wechat_reading_book_detail: async (params, env: Env) => {
      const bookId = String(params.bookId ?? "");
      const cookie = env.WEREAD_COOKIE ?? "";
      const baseUrl = env.WEREAD_BASE_URL ?? "https://weread.qq.com";

      if (!cookie) {
        return {
          content: [
            { type: "text", text: "⚠️ 未配置 WEREAD_COOKIE" },
          ],
          isError: true,
        };
      }

      try {
        const data = (await wereadFetch(
          `/api/web/book/info?bookId=${encodeURIComponent(bookId)}`,
          cookie,
          baseUrl
        )) as any;

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  bookId: data.bookId ?? bookId,
                  title: data.title ?? "",
                  author: data.author ?? "",
                  cover: data.cover ?? "",
                  intro: data.intro ?? "",
                  publisher: data.publisher ?? "",
                  isbn: data.isbn ?? "",
                  publishTime: data.publishTime ?? "",
                  category: data.category ?? "",
                  rating: data.newRating ?? 0,
                  totalWords: data.totalWords ?? 0,
                },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `获取详情失败: ${err.message}` },
          ],
          isError: true,
        };
      }
    },

    // ---- 热门标注 ----
    wechat_reading_book_notes: async (params, env: Env) => {
      const bookId = String(params.bookId ?? "");
      const limit = Number(params.limit ?? 20);
      const cookie = env.WEREAD_COOKIE ?? "";
      const baseUrl = env.WEREAD_BASE_URL ?? "https://weread.qq.com";

      if (!cookie) {
        return {
          content: [
            { type: "text", text: "⚠️ 未配置 WEREAD_COOKIE" },
          ],
          isError: true,
        };
      }

      try {
        const data = (await wereadFetch(
          `/api/web/book/highlights?bookId=${encodeURIComponent(bookId)}&limit=${limit}`,
          cookie,
          baseUrl
        )) as any;

        const highlights = (data?.highlights ?? data?.items ?? [])
          .slice(0, limit)
          .map((h: any) => ({
            chapterUid: h.chapterUid,
            content: h.content ?? h.markText ?? "",
            createTime: h.createTime,
          }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { bookId, total: highlights.length, highlights },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `获取笔记失败: ${err.message}` },
          ],
          isError: true,
        };
      }
    },

    // ---- 书评 ----
    wechat_reading_book_reviews: async (params, env: Env) => {
      const bookId = String(params.bookId ?? "");
      const limit = Number(params.limit ?? 10);
      const cookie = env.WEREAD_COOKIE ?? "";
      const baseUrl = env.WEREAD_BASE_URL ?? "https://weread.qq.com";

      if (!cookie) {
        return {
          content: [
            { type: "text", text: "⚠️ 未配置 WEREAD_COOKIE" },
          ],
          isError: true,
        };
      }

      try {
        const data = (await wereadFetch(
          `/api/web/review/list?bookId=${encodeURIComponent(bookId)}&listType=6&maxIdx=0&count=${limit}`,
          cookie,
          baseUrl
        )) as any;

        const reviews = (data?.reviews ?? data?.items ?? [])
          .slice(0, limit)
          .map((r: any) => ({
            userName: r.user?.name ?? r.userName ?? "",
            rating: r.rating ?? r.score ?? 0,
            content: r.content ?? r.reviewContent ?? "",
            createTime: r.createTime,
          }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { bookId, total: reviews.length, reviews },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `获取书评失败: ${err.message}` },
          ],
          isError: true,
        };
      }
    },

    // ---- 推荐书单 ----
    wechat_reading_recommend: async (params, env: Env) => {
      const category = String(params.category ?? "");
      const cookie = env.WEREAD_COOKIE ?? "";
      const baseUrl = env.WEREAD_BASE_URL ?? "https://weread.qq.com";

      if (!cookie) {
        return {
          content: [
            { type: "text", text: "⚠️ 未配置 WEREAD_COOKIE" },
          ],
          isError: true,
        };
      }

      try {
        const path = category
          ? `/api/web/category/books?category=${encodeURIComponent(category)}`
          : `/api/web/recommend`;
        const data = (await wereadFetch(path, cookie, baseUrl)) as any;

        const books = (data?.books ?? data?.items ?? data?.list ?? [])
          .slice(0, 10)
          .map(extractBookInfo);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { category: category || "全部", total: books.length, books },
                null,
                2
              ),
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [
            { type: "text", text: `获取推荐失败: ${err.message}` },
          ],
          isError: true,
        };
      }
    },
  },
};
