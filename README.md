# dsh-opencodehub

把 CLIProxyAPI 的 opencodehub 插件移植为 DeepSeek Harness（DSH）的 LLM 适配器插件：
直连 OpenCode Zen 免费层（`https://opencode.ai/zen/v1/chat/completions`），在 DSH 里注册为一个名为
`opencodehub` 的模型提供方。当前对齐上游 **0.1.2**（出口自愈）。

## 安装（已完成的部分见下方「本机状态」）

1. 依赖装进 DSH profile（`file:` 协议指向本目录）：

   ```jsonc
   // C:\Users\MECHREV\.dsh\profiles\desktop\package.json
   "dependencies": { "dsh-opencodehub": "file:D:/Download games/dsh插件/dsh-opencodehub" }
   // dsh.profile.bundles 数组里加 "dsh-opencodehub"
   ```

   然后 `pnpm install --dir <profile 目录>`。

2. 重启 DSH。插件 `apply()` 会执行 `ctx.llm.registerAdapter(['opencodehub'], adapter)`，
   GUI 模型选择器里出现「OpenCode Zen (free tier)」提供方与 10 个内置模型。

## 配置（Config，全部有默认值，零配置可用）

| 字段 | 默认 | 说明（Go 原版对应） |
| --- | --- | --- |
| `proxy` | `http://127.0.0.1:7897` | 出站代理；`direct`/`none`/`off` 直连（OPENCODEHUB_PROXY 同义） |
| `baseUrl` | `https://opencode.ai/zen` | Zen API 基址 |
| `maxAttempts` | `3` | 每次聊天请求最多尝试次数，每次新 session id |
| `headerTimeoutMs` | `10000` | 响应头超时（zenHeaderTimeout） |
| `requestTimeoutMs` | `600000` | 整请求 deadline（zenRequestTimeout） |
| `dialTimeoutMs` | `3000` | 代理拨号超时 |
| `retryBackoffMs` | `400` | 线性退避基数（400ms × attempt） |
| `directoryTtlMs` | `600000` | `/zen/v1/models` 目录缓存 TTL |

## 移植了什么（对应 Go 源）

- **十头门禁**（zen.go）：`Accept-Encoding: identity`、`Content-Type`、`Content-Length`、
  `Authorization: Bearer public`、`User-Agent: opencode/latest/2.0.29/cli`、
  `x-opencode-client: cli`、`x-opencode-project: global`、
  `x-opencode-request: msg_*`（升序）、`x-opencode-session`/`x-opencode-session-id`（降序 `ses_*`，
  ocID 算法逐位移植）。
- **read 工具门禁**（tools.go）：tools 数组必须含小写 `read`（`bash` 可选）；客户端大写/别名出站改名、
  入站改回；未声明的门禁工具注入 placeholder，模型真调了则丢弃该调用，`tool_calls` finish 坍缩为 `stop`。
- **强制流式**（executor.go）：`stream:true` 无条件写入，SSE 折叠为 dsh-llm StreamChunk
  （text/reasoning/tool-call 块、usage、恰一个终止 finish）。
- **重试**：403/429/5xx 与传输错误在未向消费方转发任何字节时可重试，每次新 session/msg id；
  已转发则绝不重放。
- **出口自愈（0.1.2）**：免费档按地址段封禁（机房出口 403 `FreeTierError`，家宽 200）。收到
  `403` 且响应体带 `FreeTierError` → 挂起代理 10 分钟、下一次尝试**无退避直接拨号**；经代理的
  拨号失败（Clash 关了）→ 挂起 5 分钟同样改直连。两种 403 措辞都识别，判据只看 `FreeTierError`
  类型标记；`proxy: direct` 写死直连时不做任何代理尝试。挂起到期自动恢复走代理。
- **模型目录**（models.go）：静态注册 10 个免费模型 + 惰性拉取 `/zen/v1/models`（只增不减、
  排除退役名单），上下文 262144 / 默认输出 32768。
- **错误语义**：200 包错误对象、聚合不出内容、无 finish 的流均映射为带稳定 code 的 LlmError
  （AUTH/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE…）。

## 与原版的刻意偏差

- **归因头**：dsh-llm 适配器契约要求每个上游请求带 `attributionHeaders()`（`user-agent:
  deepseek-harness/...`），但 Zen 以 UA 参与门禁指纹，发送会 403。本适配器按协议仿真优先，
  发送 opencode CLI 原版 UA；此偏差为已知且有意。
- **目录轮询**：Go 原版后台每 10 分钟拉一次目录；这里改为 `listModels()` 惰性拉取 + TTL 缓存
  （无后台定时器，行为等价）。
- **管理面板**：CPA 的只读管理页不移植；配置走 DSH 插件 Config schema。

## 本机状态（2026-10-19）

- 已通过：`test/unit.mjs`（离线全绿，含 0.1.2 出口自愈四用例移植）、`test/smoke.mjs`（真实出流 OK）、
  `test/smoke2.mjs`（真实工具调用回合，Read 门禁改名+参数流式）、`test/smoke3.mjs`（死代理 59999 →
  拨号失败挂起 5 分钟 → 下一次直连成功出字，与 Go `TestProxyBlockExpires` 同型验证）。
- 已安装进 desktop profile 并验证模块可加载；**待用户重启 DSH 后在 GUI 里确认模型选择器**。
- 运行时依赖解析：`undici`、`@deepseek-ai/schemastery` 来自 profile hoisted node_modules；
  `@deepseek-ai/cordis` 仅为 peerDep 声明，运行时不 import（DSH 无公开 cordis 运行时导出需求）。

## 变更记录

- **0.1.2（对齐上游 1e7eed54）**：出口被拒时自愈——403 FreeTierError 挂起代理 10 分钟改直连
  （无退避立即重试）；代理拨号失败挂起 5 分钟；目录拉取共享同一出口决策；`egressLabel()` 对应
  Go `transportLabel`。版本号 `0.1.0` → `0.1.2`。
- **0.1.0**：初版移植（对齐上游 0.1.1 / d11b6e67）。
