# mcp-deepseek-search

[简体中文](https://github.com/Matthewyin/deepseek-mcp/blob/main/README.zh-CN.md)

[![npm version](https://img.shields.io/npm/v/mcp-deepseek-search.svg)](https://www.npmjs.com/package/mcp-deepseek-search)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.Matthewyin-blue)](https://registry.modelcontextprotocol.io)

An [Model Context Protocol](https://modelcontextprotocol.io) server that exposes [DeepSeek's web **Search**, **Fetch**, **OCR**, **ASR** and **TTS** tools](https://api-docs.deepseek.com/zh-cn/api/search) to any MCP client — Claude Desktop, Claude Code, Cursor, Cline, ZCode, and more.

Works with **any** LLM: the tools run on DeepSeek's APIs, but the results are returned to your existing model as ordinary tool output.

## Features

- **`deepseek_search`** — web search backed by DeepSeek's search engine, with two quality signals per result:
  - `rerank_score` (0–3): relevance; **≥ 1.5 = highly relevant**
  - `authority` (0–4, `-1` unknown): source authority; **≥ 3 = highly authoritative**
- **`deepseek_fetch`** — fetch a single page and get its main content as Markdown
- **`deepseek_ocr`** — extract text from PDF / Word / PPT / images (incl. scanned pages), per page
- **`deepseek_asr`** — transcribe 16-bit PCM WAV or Ogg Opus audio to text
- **`deepseek_tts`** — synthesize speech (`stella` female / `tide` male) to a local wav/pcm file
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

### `deepseek_ocr`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file_path` | string | yes | Local path to a PDF, Word, PowerPoint or image file |
| `purpose` | string | no | `text_recognition` (default) or `rich_layout_recognition` (page-by-page layout-aware recognition) |

Returns per-page `text` (each page truncated at 8,000 chars) with `page_count` and `finish_reason` per page.

### `deepseek_asr`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `file_path` | string | yes | Local path to 16-bit PCM WAV or Ogg Opus audio |

Returns `text` and `duration_ms`.

### `deepseek_tts`

| Parameter | Type | Required | Description |
|---|---|---|---|
| `text` | string | yes | The text to speak |
| `voice_id` | string | no | `stella` (female, default) or `tide` (male) |
| `format` | string | no | `wav` (default) or raw `pcm` (24 kHz, 16-bit signed, mono) |
| `output_path` | string | no | Path for a new audio file. Existing paths are rejected. Defaults to a file in a private temp directory |

## Example

Ask your agent: *"用 deepseek_search 搜一下最近一周关于 MCP 的大新闻，挑权威来源，再用 deepseek_fetch 读全文总结"* — or in English: *"Search for recent DeepSeek news, keep only results with authority ≥ 3, fetch the top one and summarize."*

## Notes & limits

- Rate limit is **5 QPS per DeepSeek account** (shared across all your API keys); the server throttles automatically.
- HTTP 402 means your DeepSeek balance ran out; 401 means the key is invalid.
- Page content depends on the target site's availability and access policy.
- OCR / ASR / TTS have their own file-format and billing rules — see the [API docs](https://api-docs.deepseek.com/zh-cn/api/ocr) for details.
- OCR and ASR accept regular files up to 100 MiB and 8 MiB, respectively. Each server process handles one file upload at a time. If an upload is already running, retry after it finishes.
- This is an unofficial community wrapper; not affiliated with DeepSeek.

## Development

```bash
npm install
npm run build
npm run test:security           # file tool regression tests with a local mock API
DEEPSEEK_API_KEY=sk-... npm test   # end-to-end test against the real API
```

Pushing a `v*` tag starts a GitHub Actions release. After publishing to npm, the workflow waits for the exact package version to appear in the public npm registry before publishing `server.json` to the official MCP Registry. The npm visibility check times out after 10 minutes.

## License

[MIT](LICENSE)
