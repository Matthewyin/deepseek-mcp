import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const mockApi = String.raw`
const originalSetTimeout = globalThis.setTimeout;
let expireRequest;
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay >= 120_000) expireRequest = () => callback(...args);
  return originalSetTimeout(callback, delay, ...args);
};

const attempts = new Map();
globalThis.fetch = async (url, { body, signal }) => {
  if (url.endsWith("/search")) return Response.json({ results: [{ title: body }] });

  const name = body.get("file").name;
  const key = url + name;
  const attempt = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, attempt);
  switch (name) {
    case "ocr-error":
      return new Response("\n\n" + JSON.stringify({
        error: { message: "OCR did not finish in time", code: "gateway_timeout_error" }
      }));
    case "invalid-ocr":
      return Response.json({ page_count: 1, pages: [] });
    case "busy":
      if (attempt === 1) return new Response("Try again later", { status: 503 });
      break;
    case "timeout":
      if (attempt === 1) {
        return new Promise((_, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          expireRequest();
        });
      }
      break;
    case "cancel":
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          process.stderr.write("mock request cancelled\n");
          reject(signal.reason);
        }, { once: true });
        process.stderr.write("mock request started\n");
      });
  }
  if (url.endsWith("/ocr")) {
    return Response.json({ page_count: 1, pages: [{ index: 0, text: "test document", finish_reason: "stop" }] });
  }
  if (url.endsWith("/asr")) {
    return Response.json({ request_id: "test", text: "test transcript", duration_ms: 1000 });
  }
  throw new Error("Unexpected endpoint");
};
await import("./dist/index.js");
`;

test("Search, OCR and ASR API contracts", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "deepseek-contract-test-"));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--input-type=module", "--eval", mockApi],
    env: { DEEPSEEK_API_KEY: "test-key", DEEPSEEK_API_BASE: "https://example.invalid" },
    stderr: "pipe",
  });
  const client = new Client({ name: "contract-tests", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    await rm(scratch, { recursive: true, force: true });
  });
  await client.connect(transport);
  const call = (name, args, signal) =>
    client.callTool({ name, arguments: args }, undefined, { timeout: 5000, signal });
  const payload = (result) => {
    assert.equal(result.isError ?? false, false, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };
  const expectError = (result, message) => {
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, message);
  };
  const file = async (name) => {
    const file_path = join(scratch, name);
    await writeFile(file_path, "test input");
    return { file_path };
  };

  await t.test("Search counts Unicode code points and rejects out-of-contract inputs", async () => {
    const boundary = "🧪".repeat(128);
    const inputs = { query: boundary, ori_question: boundary };
    const result = payload(await call("deepseek_search", inputs));
    const sent = JSON.parse(result.results[0].title);
    assert.equal(sent.query, boundary);
    assert.equal(sent.ori_question, boundary);

    const withoutQuestion = payload(await call("deepseek_search", { query: "test", ori_question: null }));
    assert.equal("ori_question" in JSON.parse(withoutQuestion.results[0].title), false);
    expectError(await call("deepseek_search", { query: " \u3000\t" }), /cannot be blank/);
    expectError(await call("deepseek_search", { query: boundary + "a" }), /Unicode characters/);
    expectError(await call("deepseek_search", { query: "test", ori_question: boundary + "a" }), /Unicode characters/);
    expectError(await call("deepseek_search", { query: "test", ori_question: "" }), /ori_question/);
  });

  await t.test("OCR surfaces in-body errors and rejects mismatched page counts", async () => {
    expectError(await call("deepseek_ocr", await file("ocr-error")), /OCR did not finish in time/);
    expectError(await call("deepseek_ocr", await file("invalid-ocr")), /invalid OCR result/);
    const result = payload(await call("deepseek_ocr", await file("ok")));
    assert.equal(result.pages[0].text, "test document");
  });

  await t.test("OCR and ASR use separate deadlines without retrying a local timeout", async () => {
    const upload = await file("timeout");
    expectError(await call("deepseek_ocr", upload), /timed out after 185000ms/);
    expectError(await call("deepseek_asr", upload), /timed out after 660000ms/);
    const result = payload(await call("deepseek_asr", await file("busy")));
    assert.equal(result.text, "test transcript");
  });

  await t.test("cancelling an MCP upload aborts the HTTP request and frees the upload slot", { timeout: 5000 }, async () => {
    const upload = await file("cancel");
    const events = createInterface({ input: transport.stderr });
    const notice = (expected) => new Promise((resolve) => {
      const onLine = (line) => {
        if (line !== expected) return;
        events.off("line", onLine);
        resolve();
      };
      events.on("line", onLine);
    });
    const controller = new AbortController();
    try {
      const started = notice("mock request started");
      const cancelled = assert.rejects(call("deepseek_ocr", upload, controller.signal), /test cancelled/);
      await started;
      const aborted = notice("mock request cancelled");
      controller.abort(new Error("test cancelled"));
      await Promise.all([cancelled, aborted]);
      assert.equal(payload(await call("deepseek_asr", await file("ok"))).text, "test transcript");
    } finally {
      events.close();
    }
  });
});
