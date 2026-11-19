import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, truncate, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const audio = Buffer.from("RIFFtest audio");
const ocrResponse = { page_count: 1, pages: [{ index: 0, text: "test document" }] };
const asrResponse = { text: "test transcript", duration_ms: 1000 };
const mib = 1024 * 1024;

test("file tools enforce local file and upload limits", async (t) => {
  const scratch = await mkdtemp(join(tmpdir(), "deepseek-file-test-"));
  const fixture = join(scratch, "input");
  await writeFile(fixture, "test input");

  let beforeOcrResponse;
  let uploadRequests = 0;
  const upstream = createServer(async (req, res) => {
    req.resume();
    await once(req, "end");
    switch (req.url) {
      case "/v1/tools/tts":
        res.end(audio);
        break;
      case "/v1/tools/ocr":
        uploadRequests++;
        await beforeOcrResponse?.();
        res.end(JSON.stringify(ocrResponse));
        break;
      case "/v1/tools/asr":
        uploadRequests++;
        res.end(JSON.stringify(asrResponse));
        break;
      default:
        res.writeHead(404).end();
    }
  });
  upstream.listen(0, "127.0.0.1");
  const client = new Client({ name: "file-tool-tests", version: "1.0.0" });
  t.after(async () => {
    await client.close();
    upstream.closeAllConnections();
    await new Promise((done) => upstream.close(done));
    await rm(scratch, { recursive: true, force: true });
  });
  await once(upstream, "listening");
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: ["dist/index.js"],
    env: {
      DEEPSEEK_API_KEY: "test-key",
      DEEPSEEK_API_BASE: `http://127.0.0.1:${upstream.address().port}`,
      TMPDIR: scratch,
      TMP: scratch,
      TEMP: scratch,
    },
  }));

  const call = (name, args) => client.callTool(
    { name, arguments: args },
    undefined,
    { timeout: 5000 }
  );
  const payload = (result) => {
    assert.equal(result.isError ?? false, false, result.content[0].text);
    return JSON.parse(result.content[0].text);
  };

  await t.test("TTS advertises writes and preserves existing files", async () => {
    const { tools } = await client.listTools();
    const { annotations } = tools.find(({ name }) => name === "deepseek_tts");
    assert.equal(annotations.readOnlyHint, false);
    assert.equal(annotations.destructiveHint, false);

    const target = join(scratch, "output", "speech.wav");
    const args = { text: "test speech", output_path: target };
    assert.equal(payload(await call("deepseek_tts", args)).output_path, target);
    assert.deepEqual(await readFile(target), audio);
    await writeFile(target, "preserve this file");
    const result = await call("deepseek_tts", args);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /already exists/);
    assert.equal(await readFile(target, "utf8"), "preserve this file");
  });

  await t.test("default audio paths are unique and private", async () => {
    const results = await Promise.all([
      call("deepseek_tts", { text: "test wav" }),
      call("deepseek_tts", { text: "test pcm", format: "pcm" }),
    ]);
    const paths = results.map((result) => payload(result).output_path);
    assert.notEqual(dirname(paths[0]), dirname(paths[1]));
    for (const path of paths) {
      assert.deepEqual(await readFile(path), audio);
      if (process.platform !== "win32") {
        assert.equal((await stat(path)).mode & 0o777, 0o600);
        assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
      }
    }
  });

  await t.test("invalid uploads are rejected before contacting the API", async () => {
    for (const [tool, limit] of [["deepseek_ocr", 100], ["deepseek_asr", 8]]) {
      const invalidType = await call(tool, { file_path: scratch });
      assert.equal(invalidType.isError, true);
      assert.match(invalidType.content[0].text, /regular file|is a directory/);

      await truncate(fixture, limit * mib + 1);
      const oversized = await call(tool, { file_path: fixture });
      assert.equal(oversized.isError, true);
      assert.match(oversized.content[0].text, new RegExp(`maximum ${limit} MiB`));
    }
    assert.equal(uploadRequests, 0);
    await truncate(fixture, "test input".length);
  });

  await t.test("OCR and ASR share one upload slot and release it after completion", async () => {
    let releaseOcr;
    const waitForRelease = new Promise((resolve) => { releaseOcr = resolve; });
    const ocrStarted = new Promise((resolve) => {
      beforeOcrResponse = () => {
        resolve();
        return waitForRelease;
      };
    });
    const ocr = call("deepseek_ocr", { file_path: fixture });
    try {
      await Promise.race([ocrStarted, ocr.then(() => assert.fail("OCR returned before uploading"))]);
      const busy = await call("deepseek_asr", { file_path: fixture });
      assert.equal(busy.isError, true);
      assert.match(busy.content[0].text, /upload is in progress/);
      assert.equal(uploadRequests, 1);
    } finally {
      releaseOcr();
    }
    assert.equal(payload(await ocr).pages[0].text, "test document");
    assert.equal(payload(await call("deepseek_asr", { file_path: fixture })).text, asrResponse.text);
  });
});
