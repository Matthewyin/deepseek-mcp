# mcp-deepseek-search

[![npm version](https://img.shields.io/npm/v/mcp-deepseek-search.svg)](https://www.npmjs.com/package/mcp-deepseek-search)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.Matthewyin-blue)](https://registry.modelcontextprotocol.io)

An [Model Context Protocol](https://modelcontextprotocol.io) server that exposes [DeepSeek's web **Search** and **Fetch** tools](https://api-docs.deepseek.com/zh-cn/guides/search) to any MCP client — Claude Desktop, Claude Code, Cursor, Cline, ZCode, and more.

Works with **any** LLM: the search runs on DeepSeek's own search engine, but the results are returned to your existing model as ordinary tool output.

## Features

- **`deepseek_search`** — web search backed by DeepSeek's search engine, with two quality signals per result:
  - `rerank_score` (0–3): relevance; **≥ 1.5 = highly relevant**
  - `authority` (0–4, `-1` unknown): source authority; **≥ 3 = highly authoritative**
- **`deepseek_fetch`** — fetch a single page and get its main content as Markdown
- Powerful query syntax: `site:`, `-site:`, `-term`, `"exact phrase"`, `-"phrase"`, `lang:zh,en`, `after:YYYY-MM-DD`, `before:YYYY-MM-DD`
- Built-in throttling (stays under the 5 QPS account limit) and automatic retry on 408/429/5xx
- Response-size friendly: summaries by default, full page text only on request

## Setup

1. Get an API key at [platform.deepseek.com](https://platform.deepseek.com) (web tools are billed at **¥5 per 1,000 successful calls**, charged to your DeepSeek account — failed calls and empty results are not billed).
2. Add the server to your MCP client config:

### Claude Desktop / Cursor / Cline / most clients

```json
{
  "mcpServers": {
    "deepseek-web": {
      "command": "npx",
      "args": ["-y", "mcp-deepseek-search"],
      "env": {
        "DEEPSEEK_API_KEY": "sk-your-key-here"
      }
    }
  }
}
```

### ZCode

Add the same `mcpServers` block to your ZCode MCP settings (Settings → MCP → Add server).

### From source

```bash
git clone https://github.com/Matthewyin/deepseek-mcp
cd deepseek-mcp && npm install && npm run build
node dist/index.js   # stdio MCP server
```

## Tools

### `deepseek_search`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `query` | string | yes | 1–128 chars; supports the search syntax above |
| `count` | integer | no | 1–50 results, default 10 (does not affect billing) |
| `ori_question` | string | no | The user's original question — improves intent matching when the query was rewritten |
| `localization` | string | no | User IP to localize results (pass only with consent) |
| `need_content` | boolean | no | Include full page text per result (each truncated at 8,000 chars). Default `false` |

Each result includes `title`, `url`, `snippet` (short, for display), `summary` (long, for feeding to a model), `rerank_score`, `authority`, `site_name`, `date`, and optionally `content`.

### `deepseek_fetch`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `url` | string | yes | Plain `http(s)` URL, max 8,192 chars, no embedded credentials |

Returns `title` + Markdown `content` (truncated at 30,000 chars).

## Example

Ask your agent: *"用 deepseek_search 搜一下最近一周关于 MCP 的大新闻，挑权威来源，再用 deepseek_fetch 读全文总结"* — or in English: *"Search for recent DeepSeek news, keep only results with authority ≥ 3, fetch the top one and summarize."*

## Notes & limits

- Rate limit is **5 QPS per DeepSeek account** (shared across all your API keys); the server throttles automatically.
- HTTP 402 means your DeepSeek balance ran out; 401 means the key is invalid.
- Page content depends on the target site's availability and access policy.
- This is an unofficial community wrapper; not affiliated with DeepSeek.

## Development

```bash
npm install
npm run build
DEEPSEEK_API_KEY=sk-... npm test   # end-to-end test against the real API
```

Releases are automated via GitHub Actions: pushing a `v*` tag publishes to npm and the official MCP Registry.

## License

[MIT](LICENSE)
