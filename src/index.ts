#!/usr/bin/env node
/**
 * mcp-deepseek-search — MCP server for DeepSeek's web Search & Fetch tools.
 *
 * Upstream endpoints (requires a DeepSeek API key via DEEPSEEK_API_KEY):
 *   POST https://api.deepseek.com/v1/tools/search
 *   POST https://api.deepseek.com/v1/tools/fetch
 *   POST https://api.deepseek.com/v1/tools/ocr    (multipart)
 *   POST https://api.deepseek.com/v1/tools/asr    (multipart)
 *   POST https://api.deepseek.com/v1/tools/tts    (binary audio response)
 *
 * API docs: https://api-docs.deepseek.com/zh-cn/guides/search
 */
import { createRequire } from "node:module";
import { constants } from "node:fs";
import { mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const require = createRequire(import.meta.url);
const { version: VERSION } = require("../package.json") as { version: string };

const API_BASE = (process.env.DEEPSEEK_API_BASE || "https://api.deepseek.com").replace(/\/+$/, "");
const SEARCH_ENDPOINT = `${API_BASE}/v1/tools/search`;
const FETCH_ENDPOINT = `${API_BASE}/v1/tools/fetch`;
const OCR_ENDPOINT = `${API_BASE}/v1/tools/ocr`;
const ASR_ENDPOINT = `${API_BASE}/v1/tools/asr`;
const TTS_ENDPOINT = `${API_BASE}/v1/tools/tts`;

const MAX_CONTENT_CHARS_PER_RESULT = 8000;
const MAX_FETCH_CONTENT_CHARS = 30000;
const MIB = 1024 * 1024;
const OCR_MAX_FILE_BYTES = 100 * MIB;
const ASR_MAX_FILE_BYTES = 8 * MIB;

const MAX_ATTEMPTS = 3;
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const SEARCH_QPS = 100;
const FETCH_QPS = 25;
const MEDIA_MIN_INTERVAL_MS = 220;

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

function createThrottle(intervalMs: number): () => Promise<void> {
  let nextStart = 0;
  let queue = Promise.resolve();
  return () => {
    queue = queue.then(async () => {
      let waitMs = nextStart - performance.now();
      while (waitMs > 0) {
        await sleep(Math.ceil(waitMs));
        waitMs = nextStart - performance.now();
      }
      // 从实际放行时刻计算下次间隔，避免定时器延迟后集中放行。
      nextStart = performance.now() + intervalMs;
    });
    return queue;
  };
}

// 比官方额度对应的间隔多留 1 毫秒。
const webThrottles = new Map([
  [SEARCH_ENDPOINT, createThrottle(Math.ceil(1000 / SEARCH_QPS) + 1)],
  [FETCH_ENDPOINT, createThrottle(Math.ceil(1000 / FETCH_QPS) + 1)],
]);
const mediaThrottle = createThrottle(MEDIA_MIN_INTERVAL_MS);

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
  body: Record<string, unknown> | FormData,
  timeoutMs: number,
  opts: { binary?: boolean } = {}
): Promise<unknown> {
  const throttle = webThrottles.get(endpoint) ?? mediaThrottle;
  let lastError: unknown = new Error("request failed");
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await throttle();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      // For FormData, let fetch set the multipart Content-Type with its boundary.
      const res = await fetch(endpoint, {
        method: "POST",
        headers:
          body instanceof FormData
            ? { Authorization: `Bearer ${apiKey()}` }
            : {
                Authorization: `Bearer ${apiKey()}`,
                "Content-Type": "application/json",
              },
        body: body instanceof FormData ? body : JSON.stringify(body),
        signal: controller.signal,
      });
      if (res.ok) return opts.binary ? Buffer.from(await res.arrayBuffer()) : await res.json();
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

async function readFileForUpload(filePath: string, maxBytes: number): Promise<Blob> {
  try {
    // 以非阻塞方式打开，避免在检查文件类型之前等待管道。
    const file = await open(filePath, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw new Error(`Expected a regular file: ${filePath}`);
      const size = stat.size;
      if (size > maxBytes) throw new Error(`File is too large: maximum ${maxBytes / MIB} MiB`);

      // 多读一个字节，检测文件在检查大小后是否增长。
      const buffer = Buffer.allocUnsafe(size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
        if (bytesRead === 0) return new Blob([buffer.subarray(0, length)]);
        length += bytesRead;
      }
      throw new Error(`File grew while being read: ${filePath}`);
    } finally {
      await file.close();
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") throw new Error(`File not found: ${filePath}`);
    if (code === "EISDIR") throw new Error(`Path is a directory, not a file: ${filePath}`);
    throw err;
  }
}

let uploadInProgress = false;

async function uploadFile(
  endpoint: string,
  filePath: string,
  maxBytes: number,
  purpose?: string
): Promise<unknown> {
  if (uploadInProgress) throw new Error("Another file upload is in progress. Try again when it finishes.");
  uploadInProgress = true;
  try {
    apiKey();
    const form = new FormData();
    form.append("file", await readFileForUpload(filePath, maxBytes), basename(filePath));
    if (purpose !== undefined) form.append("purpose", purpose);
    return await callToolApi(endpoint, form, 120_000);
  } finally {
    uploadInProgress = false;
  }
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

server.registerTool(
  "deepseek_ocr",
  {
    title: "DeepSeek OCR",
    description:
      "Extract text from PDF, Word, PowerPoint or image files (including scanned pages) via DeepSeek's OCR API. " +
      "Returns the recognized text per page. Set purpose=rich_layout_recognition to force page-by-page layout-aware " +
      "recognition (better for complex layouts); the default text_recognition extracts plain text directly from " +
      "image-free Word/PPT files.",
    inputSchema: {
      file_path: z
        .string()
        .min(1)
        .describe("Local path of the file to recognize (PDF, Word, PPT or image). Absolute path recommended."),
      purpose: z
        .enum(["text_recognition", "rich_layout_recognition"])
        .optional()
        .describe("text_recognition (default) or rich_layout_recognition (page-by-page layout-aware recognition)."),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    try {
      const data = (await uploadFile(
        OCR_ENDPOINT,
        args.file_path,
        OCR_MAX_FILE_BYTES,
        args.purpose ?? "text_recognition"
      )) as {
        id?: string;
        purpose?: string;
        page_count?: number;
        pages?: Record<string, unknown>[];
        usage?: Record<string, unknown>;
      };
      const pages = Array.isArray(data.pages) ? data.pages : [];
      const payload = {
        id: data.id,
        purpose: data.purpose,
        page_count: data.page_count,
        pages: pages.map((p) => ({
          index: p.index,
          finish_reason: p.finish_reason,
          text: truncate(p.text, MAX_CONTENT_CHARS_PER_RESULT),
        })),
        usage: data.usage,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    } catch (err) {
      return toolError("deepseek_ocr", err);
    }
  }
);

server.registerTool(
  "deepseek_asr",
  {
    title: "DeepSeek ASR (Speech-to-Text)",
    description:
      "Transcribe an audio file to text via DeepSeek's ASR API. " +
      "The audio must be 16-bit PCM WAV or Ogg Opus; convert other formats first if needed.",
    inputSchema: {
      file_path: z
        .string()
        .min(1)
        .describe("Local path of the audio file (16-bit PCM WAV or Ogg Opus). Absolute path recommended."),
    },
    annotations: { readOnlyHint: true },
  },
  async (args) => {
    try {
      const data = (await uploadFile(ASR_ENDPOINT, args.file_path, ASR_MAX_FILE_BYTES)) as {
        request_id?: string;
        text?: string;
        duration_ms?: number;
      };
      const payload = {
        request_id: data.request_id,
        text: data.text,
        duration_ms: data.duration_ms,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    } catch (err) {
      return toolError("deepseek_asr", err);
    }
  }
);

server.registerTool(
  "deepseek_tts",
  {
    title: "DeepSeek TTS (Text-to-Speech)",
    description:
      "Synthesize speech from text via DeepSeek's TTS API and save it as a local audio file. " +
      "Returns the output file path; play it with a local player or pass it to the user. " +
      "Markdown syntax is stripped before synthesis by default.",
    inputSchema: {
      text: z.string().min(1).describe("The text to speak. Must not be empty."),
      voice_id: z
        .enum(["stella", "tide"])
        .optional()
        .describe("Voice: stella (female, default) or tide (male)."),
      format: z
        .enum(["wav", "pcm"])
        .optional()
        .describe("Audio format: wav (default) or raw pcm (24 kHz, 16-bit signed, mono)."),
      output_path: z
        .string()
        .min(1)
        .optional()
        .describe("Path for a new audio file. Existing paths are rejected. Defaults to a private temp file."),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  async (args) => {
    try {
      const format = args.format ?? "wav";
      const body: Record<string, unknown> = { text: args.text, format };
      if (args.voice_id) body.voice_id = args.voice_id;
      const audio = (await callToolApi(TTS_ENDPOINT, body, 120_000, { binary: true })) as Buffer;
      const outPath = args.output_path ??
        join(await mkdtemp(join(tmpdir(), "deepseek-tts-")), `speech.${format}`);
      if (args.output_path) await mkdir(dirname(outPath), { recursive: true });
      try {
        await writeFile(outPath, audio, { flag: "wx", mode: 0o600 });
      } catch (err) {
        if (!args.output_path) await rm(dirname(outPath), { recursive: true, force: true }).catch(() => {});
        if ((err as NodeJS.ErrnoException).code === "EEXIST") {
          throw new Error(`Output file already exists: ${outPath}`);
        }
        throw err;
      }
      const payload = {
        output_path: outPath,
        format,
        bytes: audio.length,
      };
      return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
    } catch (err) {
      return toolError("deepseek_tts", err);
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
