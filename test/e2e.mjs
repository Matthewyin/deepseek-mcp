// End-to-end test: spawns the built server over stdio and exercises it
// through the MCP protocol with the real DeepSeek API.
// Usage: DEEPSEEK_API_KEY=sk-... npm test
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

let failures = 0;
function check(name, ok, extra = "") {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  — " + extra : ""}`);
  if (!ok) failures++;
}

// --- session 1: happy path with the real API -----------------------------
const transport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: process.env.DEEPSEEK_API_KEY ? process.env : { ...process.env, DEEPSEEK_API_KEY: "" },
});
const client = new Client({ name: "e2e-test", version: "0.0.0" });
await client.connect(transport);

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name).sort();
check("tools/list exposes both tools", JSON.stringify(names) === JSON.stringify(["deepseek_fetch", "deepseek_search"]), names.join(", "));

const search = await client.callTool({
  name: "deepseek_search",
  arguments: {
    query: "DeepSeek V4 发布",
    count: 3,
    ori_question: "DeepSeek V4 什么时候发布的？有哪些新特性？",
  },
});
const searchOk = !search.isError && Array.isArray(search.content) && search.content.length > 0;
check("deepseek_search returns results", searchOk, search.isError ? String(search.content?.[0]?.text).slice(0, 200) : "");
if (!searchOk) {
  console.log("\nTESTS ABORTED: see failure above");
  process.exit(1);
}
const searchPayload = JSON.parse(search.content[0].text);
check(
  "search payload has scored results",
  searchPayload.result_count > 0 &&
    searchPayload.results.every(
      (r) => typeof r.rerank_score === "number" && typeof r.url === "string" && typeof r.summary === "string"
    ),
  `count=${searchPayload.result_count}`
);

const firstUrl = searchPayload.results[0].url;
const fetched = await client.callTool({ name: "deepseek_fetch", arguments: { url: firstUrl } });
const fetchOk = !fetched.isError;
check("deepseek_fetch returns markdown", fetchOk, fetched.isError ? String(fetched.content?.[0]?.text).slice(0, 200) : "");
const fetchPayload = JSON.parse(fetched.content[0].text);
check(
  "fetch payload has title + content",
  typeof fetchPayload.title === "string" && typeof fetchPayload.content === "string" && fetchPayload.content.length > 0,
  `chars=${(fetchPayload.content || "").length}`
);

// need_content=true branch
const withContent = await client.callTool({
  name: "deepseek_search",
  arguments: { query: "site:arxiv.org deepseek", count: 1, need_content: true },
});
const withContentPayload = JSON.parse(withContent.content[0].text);
check(
  "need_content=true includes page text",
  !withContent.isError &&
    typeof withContentPayload.results[0]?.content === "string" &&
    withContentPayload.results[0].content.length > 100,
  ""
);

// oversized query -> tool-level error, not a crash
let oversizeErrored = false;
try {
  const r = await client.callTool({ name: "deepseek_search", arguments: { query: "x".repeat(200) } });
  oversizeErrored = r.isError === true;
} catch {
  oversizeErrored = true; // JSON-RPC invalid-params is also acceptable
}
check("oversized query is rejected gracefully", oversizeErrored, "");

await client.close();

// --- session 2: missing key must surface as a tool error ------------------
const badTransport = new StdioClientTransport({
  command: process.execPath,
  args: ["dist/index.js"],
  env: { PATH: process.env.PATH || "", HOME: process.env.HOME || "" },
});
const badClient = new Client({ name: "e2e-test-nokey", version: "0.0.0" });
await badClient.connect(badTransport);
const noKey = await badClient.callTool({ name: "deepseek_search", arguments: { query: "test" } });
const noKeyText = String(noKey.content?.[0]?.text || "");
check("missing DEEPSEEK_API_KEY yields clear tool error", noKey.isError === true && noKeyText.includes("DEEPSEEK_API_KEY"), noKeyText.slice(0, 120));
await badClient.close();

console.log(failures === 0 ? "\nALL TESTS PASSED" : `\n${failures} TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
