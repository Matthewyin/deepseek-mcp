# mcp-deepseek-search

[English](README.md)

[![npm 版本](https://img.shields.io/npm/v/mcp-deepseek-search.svg)](https://www.npmjs.com/package/mcp-deepseek-search)
[![MIT 许可证](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![官方 MCP Registry](https://img.shields.io/badge/MCP_Registry-io.github.Matthewyin-blue)](https://registry.modelcontextprotocol.io/)

在 Claude Code、Codex 和 ZCode 中通过 [MCP](https://modelcontextprotocol.io/) 使用 DeepSeek 的网页搜索、网页正文提取、OCR、语音转写和语音合成工具。客户端启动本地 MCP 服务，服务调用 DeepSeek API，再把结果返回给你当前使用的模型。

## 安装

需要 Node.js 18 或更高版本，以及 [DeepSeek 开放平台](https://platform.deepseek.com/) 的 API 密钥。

### Claude Code 和 ZCode

Claude Code 将下面的配置添加到项目的 `.mcp.json`，并把占位值改为 `${DEEPSEEK_API_KEY}`，从环境变量读取密钥。ZCode 在「设置 → MCP → 添加服务器」中填写，并把占位值换成你的密钥。

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

### Codex

将以下内容添加到 `~/.codex/config.toml`，并把占位值换成你的密钥。

```toml
[mcp_servers.deepseek-web]
command = "npx"
args = ["-y", "mcp-deepseek-search"]

[mcp_servers.deepseek-web.env]
DEEPSEEK_API_KEY = "sk-your-key-here"
```

## 工具

### `deepseek_search` 网页搜索

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `query` | 是 | 1–128 字符。支持 `site:`、`-site:`、`-关键词`、`"精确短语"`、`-"排除短语"`、`lang:zh,en`、`after:YYYY-MM-DD` 和 `before:YYYY-MM-DD` |
| `count` | 否 | 返回 1–50 条结果，默认 10 条 |
| `ori_question` | 否 | 查询经过改写时，可传入用户的原始问题，帮助匹配搜索意图 |
| `localization` | 否 | 用户 IP，用于按地区调整结果，经用户同意后传入 |
| `need_content` | 否 | 默认返回摘要。设为 `true` 时附带网页正文，每条正文最多保留 8,000 字符 |

结果包含标题、网址、摘要、站点、日期以及两项评分。`rerank_score` 是相关性评分，范围 0–3，1.5 及以上表示高度相关。`authority` 是来源权威性评分，范围 0–4，3 及以上表示权威性较高，`-1` 表示未知。

### `deepseek_fetch` 网页正文提取

传入 `url`。支持最长 8,192 字符的 HTTP 或 HTTPS 网址，网址中不能包含账号和密码。返回标题和 Markdown 正文，正文最多保留 30,000 字符。

### `deepseek_ocr` 文字识别

传入本地文件路径 `file_path`，支持 PDF、Word、PowerPoint 和图片，包括扫描件。可选的 `purpose` 默认为 `text_recognition`。复杂版面可选择 `rich_layout_recognition`，启用逐页版面识别。结果包含页数、每页文字和识别结束原因，每页文字最多保留 8,000 字符。

### `deepseek_asr` 语音转写

传入本地音频路径 `file_path`，支持 16 位 PCM WAV 或 Ogg Opus。返回转写文字和毫秒时长 `duration_ms`。

### `deepseek_tts` 语音合成

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `text` | 是 | 要朗读的文字 |
| `voice_id` | 否 | `stella` 为女声，默认使用。 `tide` 为男声 |
| `format` | 否 | 默认 `wav`，也可用 `pcm`（24 kHz、16 位有符号、单声道） |
| `output_path` | 否 | 新音频文件的位置。省略时写入私有临时目录。已有路径会被拒绝 |

返回音频路径、格式和字节数。

## 使用示例

> 用 `deepseek_search` 查找最近一周的 MCP 新闻，优先选择来源权威评分达到 3 的结果，再用 `deepseek_fetch` 读取最相关的两篇并总结。

## 使用限制

- OCR 和 ASR 会把指定文件上传到 DeepSeek。两者只接受普通文件，大小上限分别为 100 MiB 和 8 MiB。每个 MCP 服务进程同时处理一次上传，忙时可等当前上传完成后重试。[OCR 文档](https://api-docs.deepseek.com/zh-cn/guides/ocr/) · [语音识别文档](https://api-docs.deepseek.com/zh-cn/guides/asr/)
- DeepSeek 按账号分别限制 Search **100 QPS**、Fetch **25 QPS**，Fetch 还有目标域名限速。每个 MCP 服务进程对 Search 和 Fetch 独立限速，重试也计入对应接口的请求。同一账号启动的多个进程共用 DeepSeek 账号额度。[官方限速说明](https://api-docs.deepseek.com/zh-cn/guides/search/#限速)
- 服务对 HTTP 408、429 和部分 5xx 错误自动重试。HTTP 401 表示密钥无效，402 表示余额不足。
- 工具调用按 DeepSeek 的规则计费。[DeepSeek API 文档](https://api-docs.deepseek.com/zh-cn/)

## 开发和发布

```bash
git clone https://github.com/Matthewyin/deepseek-mcp
cd deepseek-mcp
npm install
npm run build
npm run test:security
DEEPSEEK_API_KEY=sk-... npm test
```

`npm run test:security` 使用本地模拟 API 检查文件工具的安全行为。`npm test` 会调用真实 DeepSeek API。构建后可用 `node dist/index.js` 启动标准输入输出（stdio）服务。

推送 `v*` 标签会触发 GitHub Actions。工作流先发布到 npm，最多等待约 10 分钟确认公开接口能查询到目标版本，然后将 `server.json` 发布到官方 MCP Registry。

## 许可证

本项目由社区维护，采用 [MIT 许可证](LICENSE)。
