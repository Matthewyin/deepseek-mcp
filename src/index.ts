#!/usr/bin/env node
/**
 * mcp-deepseek-search — MCP server for DeepSeek's web Search & Fetch tools.
 *
 * Upstream endpoints (requires a DeepSeek API key via DEEPSEEK_API_KEY):
 *   POST https://api.deepseek.com/v1/tools/search
 *   POST https://api.deepseek.com/v1/tools/fetch
 *
 * API docs: https://api-docs.deepseek.com/zh-cn/guides/search
 */
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../package.json") as { version: string };

const API_BASE = (process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com").replace(/\/+$/, "");
const SEARCH_ENDPOINT = `${API_BASE}/v1/tools/search`;
const FETCH_ENDPOINT = `${API_BASE}/v1/tools/fetch`;

const MAX_CONTENT_CHARS_PER_RESULT = 8000;
const MAX_FETCH_CONTENT_CHARS = 30000;

const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
// Account-level limit is 5 QPS; stay comfortably below it.
const MIN_INTERVAL_MS = 220;

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function apiKey(): string {
  const key = process.env.DEEPSEEK_API_KEY;
  if (!key) {
    throw new Error(
      "DEEPSEEK_API_KEY is not set. Create a key at https://platform.deepseek.com and add it to the MCP server config's env block."
    );
  }
  return key;
}

// Serialize calls so concurrent tool invocations stay under the QPS limit.
let nextSlot = 0;
async function throttle(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextSlot - now);
  nextSlot = Math.max(now, nextSlot) + MIN_INTERVAL_MS;
  if (wait > 0) await sleep(wait);
}

function friendlyStatus(status: number, body: string): string {
  const detail = body.slice(0, 300);
  switch (status) {
    case 400:
      return `Bad request (HTTP 400): query must be 1-128 chars, url must be a plain http/https URL. ${detail}`;
    case 401:
      return `Invalid DeepSeek API key (HTTP 401). ${detail}`;
    case 402:
      return `DeepSeek account balance is insufficient (HTTP 402). Top up at https://platform.deepseek.com. ${detail}`;
    case 403:
      return `Request rejected by DeepSeek safety policy (HTTP 403). ${detail}`;
    case 404:
      return `Page content could not be retrieved (HTTP 404) — the target site may block crawlers. ${detail}`;
    case 413:
      return `Request body too large (HTTP 413). ${detail}`;
    default:
      return `DeepSeek tools API returned HTTP ${status}. ${detail}`;
  }
}

async function callToolApi(
  endpoint: string,
  body: Record<string, unknown>,
  timeoutMs: number
): Promise<unknown> {
  let lastError: unknown = new Error("request failed");
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await throttle();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey()}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok) return await res.json();
      const text = await res.text().catch(() => "");
      const err = new ApiError(res.status, friendlyStatus(res.status, text));
      if (!RETRYABLE_STATUS.has(res.status)) throw err;
      lastError = err;
    } catch (err) {
      if (err instanceof ApiError && !RETRYABLE_STATUS.has(err.status)) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        lastError = new Error(`Request timed out after ${timeoutMs}ms`);
      } else {
        lastError = err;
      }
    } finally {
      clearTimeout(timer);
    }
    if (attempt < MAX_ATTEMPTS) await sleep(600 * 2 ** (attempt - 1) + Math.random() * 250);
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function truncate(text: unknown, max: number): unknown {
  if (typeof text !== "string" || text.length <= max) return text;
  return text.slice(0, max) + `… [truncated ${text.length - max} chars]`;
}

function mapSearchResult(r: Record<string, unknown>, withContent: boolean) {
  const item: Record<string, unknown> = {
    title: r.title,
    url: r.url,
    snippet: r.snippet,
    summary: truncate(r.summary, 1500),
    rerank_score: typeof r.rerank_score === "number" ? Math.round(r.rerank_score * 1000) / 1000 : r.rerank_score,
    authority: r.authority,
    site_name: r.site_name,
    date: r.date,
  };
  if (withContent) item.content = truncate(r.content, MAX_CONTENT_CHARS_PER_RESULT);
  return item;
}

function toolError(tool: string, err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: "text" as const, text: `${tool} failed: ${message}` }],
    isError: true,
  };
}

const server = new McpServer({ name: "mcp-deepseek-search", version: VERSION });

server.registerTool(
  "deepseek_search",
  {
    title: "DeepSeek Web Search",
    description:
      "Web search powered by DeepSeek's search engine. Returns ranked results with two quality signals: " +
      "rerank_score (0-3; >=1.5 means highly relevant) and authority (0-4; >=3 means highly authoritative source, -1 unknown). " +
      "Query syntax: site: (limit to site), -site: (exclude site), -term (exclude word), \"exact phrase\", -\"phrase\" (exclude phrase), " +
      "lang:zh,en (limit languages), after:YYYY or after:YYYY-MM-DD, before:YYYY-MM-DD. " +
      "By default returns summaries only; set need_content=true to include full page text (larger response).",
    inputSchema: {
      query: z
        .string()
        .min(1)
        .max(128)
        .describe("Search query, 1-128 Unicode chars. Supports site:, lang:, after:/before:, \"phrases\" and -exclusions."),
      count: z.number().int().min(1).max(50).optional().describe("Number of results to return, 1-50. Default 10."),
      ori_question: z
        .string()
        .max(4000)
        .optional()
        .describe("The user's original question, if the query was rewritten. Improves intent understanding."),
      localization: z
        .string()
        .optional()
        .describe("User IP address used to localize results. Only pass it when appropriate and with consent."),
      need_content: z
        .boolean()
        .optional()
        .describe("Include full page content per result (truncated at 8000 chars each). Default false."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const withContent = args.need_content === true;
      const body: Record<string, unknown> = { query: args.query, count: args.count ?? 10 };
      if (args.ori_question) body.ori_question = args.ori_question;
      if (args.localization) body.localization = args.localization;
      body.need_content = withContent;
      const data = (await callToolApi(SEARCH_ENDPOINT, body, 30_000)) as { results?: unknown[] };
      const results = Array.isArray(data.results) ? data.results : [];
      const payload = {
        query: args.query,
        result_count: results.length,
        scoring: "rerank_score: 0-3 (>=1.5 highly relevant); authority: 0-4 (>=3 highly authoritative, -1 unknown)",
        results: results.map((r) => mapSearchResult(r as Record<string, unknown>, withContent)),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    } catch (err) {
      return toolError("deepseek_search", err);
    }
  }
);

server.registerTool(
  "deepseek_fetch",
  {
    title: "DeepSeek Web Fetch",
    description:
      "Fetch a single web page and return its main content converted to Markdown (truncated at 30000 chars). " +
      "Use after deepseek_search to read a specific result URL in full. Plain http/https URLs only; " +
      "result availability depends on the target site's access policy.",
    inputSchema: {
      url: z
        .string()
        .min(1)
        .max(8192)
        .refine((u) => /^https?:\/\//i.test(u), "Only http/https URLs are supported")
        .refine((u) => !/^https?:\/\/[^/]*@/i.test(u), "URL must not embed credentials (user:password@host)")
        .describe("The page URL to fetch."),
    },
    annotations: { readOnlyHint: true, openWorldHint: true },
  },
  async (args) => {
    try {
      const data = (await callToolApi(FETCH_ENDPOINT, { url: args.url }, 60_000)) as Record<string, unknown>;
      const payload = {
        title: data.title,
        url: args.url,
        content: truncate(data.content, MAX_FETCH_CONTENT_CHARS),
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    } catch (err) {
      return toolError("deepseek_fetch", err);
    }
  }
);

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
