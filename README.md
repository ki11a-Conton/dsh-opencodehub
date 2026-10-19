# dsh-opencodehub

把 CLIProxyAPI 的 [opencodehub](https://github.com/ki11a-Conton/opencodehub) 插件移植为 **DeepSeek Harness（DSH）**
的 LLM 适配器插件：直连 **OpenCode Zen 免费层**（`https://opencode.ai/zen/v1/chat/completions`），在 DSH 里注册为一个名为
`opencodehub` 的模型提供方。当前对齐上游 **0.1.2**（出口自愈），DSH 侧版本 **0.1.3**（装完即用）。

**不需要 API key**——Zen 免费档用 `Authorization: Bearer public`，插件已内置。

**装完即用**：`dsh plugin --profile desktop add dsh-opencodehub@github:ki11a-Conton/dsh-opencodehub`
→ 重启 DSH → 直接说话。插件的补丁层会自动把新会话默认模型指向 Zen 免费模型，**不用改任何配置文件**。

---

## 一、装好之后怎么用（不用改任何配置）

**装完 + 重启 DSH，直接就能用。** 本插件的 bundle 补丁层已经把「新会话默认模型」指向了
Zen 免费模型（`opencodehub` / `beam-free`），你不需要手动编辑任何 YAML。

所以最短路径就是：

1. 装插件（见 [四、安装](#四安装)）
2. 重启 DSH
3. 随便开个对话，说一句「你好」

能出字，就说明整条链路已经通了。**不需要 API key**，也不需要配模型。

> 这一行默认模型写在插件的 bundle 补丁里（`cordis.patch.yml` 的 `agent-default-model`），
> 属于**最低优先级层**：你在 profile 补丁层里写同样的 id 就会覆盖它。
> 想换模型或恢复 DSH 官方默认，见下面「方式 3」。

### 方式 1：就这么用（默认已经是 Zen 免费模型）

DSH 启动后，新会话的模型就是 `opencodehub/beam-free`。直接说话即可。

### 方式 2：换成别的 Zen 免费模型

**① 点输入框的模型座位**
聊天输入框旁边显示当前模型的地方（形如 `Beam (free)`），点开就是模型选择器。

**② 或者敲 `/model`**
在输入框里输入 `/`，命令面板会列出可用命令，选 **模型 / Model**（描述是「选择本会话使用的模型」）。
也可以直接输入 `/model` 回车。

**③ 在弹出的列表里找 `OpenCode Zen (free tier)` 分组**
分组名就是提供方名字，展开后是这些免费模型（前 10 个是插件内置目录，
其余是运行时从 Zen 目录接口发现、自动并入的）：

| 模型 ID | 显示名 |
| --- | --- |
| `big-pickle` | Big Pickle |
| `cat-jam-free` | Cat Jam (free) |
| `mimo-v2.6-flash-free` | MiMo v2.6 Flash (free) |
| `deepseek-v4.1-flash-free` | DeepSeek v4.1 Flash (free) |
| `nemotron-3.5-lightning-free` | Nemotron 3.5 Lightning (free) |
| `nemotron-3.5-super-vl-free` | Nemotron 3.5 Super VL (free) |
| `longcat-2.5-preview-free` | LongCat 2.5 Preview (free) |
| `space-bunny-free` | Space Bunny (free) |
| `beam-free` | Beam (free) ← 默认 |
| `glm-5.3-flash-free` | GLM 5.3 Flash (free) |
| `minimax-m3.1-flash-free` | Minimax M3.1 Flash (free) ← 目录发现 |

列表里的模型总数超过 4 个时，顶部会出现搜索框（占位符「搜索模型…」），
输入 `glm`、`beam`、`minimax` 之类能直接筛。

**④ 选中即刻生效**
只影响**当前这个会话**，之后的每条消息都走 Zen 免费层。开新会话会回到默认模型
（也就是 `beam-free`；想让某个模型变成永久默认，见下一小节）。

> 菜单里**没有「推理等级 / Effort」这一项**是正常的：本插件注册的模型不声明 `reasoning` 能力
> （Zen 免费档不暴露可选推理档位），DSH 只在模型声明了档位时才显示该子菜单。模型仍然会输出
> 推理内容（`reasoning_content` → DSH 的 reasoning 块），只是不能由你选档位。

### 方式 3：改默认模型 / 恢复官方默认

模型选择器**只影响当前会话**，DSH 的模型菜单里没有「设为默认」按钮（截至 0.2.x）。
要让新会话永久用某个模型，得改 profile 补丁层
（`C:\Users\MECHREV\.dsh\profiles\desktop\cordis.patch.yml`），加这么一段：

```yaml
# 换成别的 Zen 免费模型
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: opencodehub
    model: glm-5.3-flash-free
```

```yaml
# 或者：恢复 DSH 官方默认（等于关掉本插件的默认模型接管）
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-official
    model: deepseek-flash
```

改完**重启 DSH**（补丁层不支持热更新）。

### 方式 4：在对话里用自然语言指定

```
用 glm-5.3-flash-free 回答这个问题：……
```

```
切到 beam-free，然后帮我看看这个文件
```

模型能通过 DSH 的工具拿到可用模型列表，会自己切。

### 怎么确认真的通了

默认就是 Zen 免费模型，所以**发一句「你好」，能出字就是通了**。想更确定，就问它
「你是什么模型」，免费档模型通常能报出自己。

如果**模型选择器里根本看不到 `OpenCode Zen` 分组**，按顺序排查：

1. 插件是否加载：在 DSH 里问「dsh-opencodehub 插件加载了吗」，或用插件调试工具查
   （预期 `phase=active`）。
2. 是否重启过 DSH（首次安装后必须重启一次）。
3. 分组标题旁边如果显示「加载失败：…」，那是网络问题——看下一节「代理」。

如果**能选模型但一说话就报 `MISSING_CREDENTIAL`**，说明默认模型那一行没生效
（例如你的 profile 补丁层里也写了 `agent-default-model` 且指向 `deepseek-official`）——
profile 层优先级更高，改掉它即可。

---

## 二、代理（大概率你需要它）

OpenCode Zen 按**出口 IP 地址段**判断是不是「在 OpenCode 里调用」：

- **家庭宽带出口** → 正常返回 200
- **机房 / VPS / 云主机出口** → `403 FreeTierError`

插件的默认配置走 `http://127.0.0.1:7897`（Clash / mihomo 的默认混合端口）。
**如果你的 Clash 用的是别的端口，或者没开代理，就要改这一项。**

### 改成别的端口

在 profile 补丁层里给插件加一段 config。**只写你要改的那个键就够了**——补丁层是「整体替换」，
但没写的键会被 Schemastery 按 schema 的 `.default()` 补齐，不需要把 8 个键都抄一遍：

```yaml
- id: dsh-opencodehub
  name: 'dsh-opencodehub'
  config:
    proxy: http://127.0.0.1:7890    # 改成你 Clash 的混合端口
```

### 直连（不走代理）

```yaml
- id: dsh-opencodehub
  name: 'dsh-opencodehub'
  config:
    proxy: direct                   # direct / none / off 都表示直连
```

### 出口自愈（0.1.2，不用你管）

插件自己会处理这几种情况，**不需要手动干预**：

| 情况 | 插件行为 |
| --- | --- |
| 走代理仍被拒（403 `FreeTierError`） | 挂起代理 **10 分钟**，下一次尝试**无退避立即改直连** |
| 代理拨号失败（Clash 没开 / 端口错） | 挂起代理 **5 分钟**，同样改直连 |
| 挂起到期 | 自动恢复走代理 |

两种 403 措辞（`only from within OpenCode` / `abusive traffic from this IP`）都识别，
判据只看响应体的 `FreeTierError` 类型标记。`proxy: direct` 写死时**完全不碰代理**，
挂起状态也不影响你。

---

## 三、能用什么、不能用什么

### ✅ 能用

- **文本对话**：内置 10 个免费模型 + 运行时目录发现的（实测当前共 11 个），
  上下文 **262,144** tokens，最大输出 **32,768** tokens
- **推理内容**：模型输出的 `reasoning_content` 会作为 DSH 的 reasoning 块正常显示
- **工具调用**：DSH 的文件读取（`read`）、写文件（`write`）、编辑（`edit`）、跑命令（`bash`）
  这些工具可用。DSH 内部工具名本来就是小写，插件的改名表按**大小写不敏感**匹配，
  出站保证是 Zen 要求的精确小写拼写，入站还原成 DSH 的拼写
- **流式输出**：Zen 只支持流式，插件内部强制 `stream: true`，DSH 侧看到的仍是正常流式

### ⚠️ 工具门禁（Zen 的硬性要求，不是插件的限制）

Zen 免费档要求**每次请求的 tools 数组里必须含小写 `read`**，否则 403。上游实测：

| 声明了哪些工具 | 结果 |
| --- | --- |
| `read` + `bash` | 200 |
| 只有 `read` | 200 |
| 只有 `bash` | 403 |

所以 `read` 是硬性必需，`bash` 可选。插件为了稳妥，**两个都缺就两个都补**：
没声明哪个，就往上游的 tools 数组里补一个同名 placeholder（描述写「must never be called」）。
模型如果真调了 placeholder，插件**丢弃该调用**，并把 `tool_calls` 的 finish 坍缩回 `stop`
——你不会看到报错，只是那一轮没有工具调用发生。

实际影响：**极少数情况下模型想读文件但那一轮工具没生效**，重发一次通常就好。

### ❌ 不能用

- **图片输入**：适配器声明的输入模态是 `['text']`（Zen 免费档这些模型都不保证视觉能力）
- **选推理等级**：见上文，菜单里没有这一项
- **非 `read`/`bash` 工具的可用性无保证**：Zen 门禁只校验这两个名字是否**存在**，
  其余工具名原样透传给上游，上游是否真的执行它们（web 搜索、MCP 工具等）本插件
  既不拦截也不保证。**有实测证据的只有文件/命令类工具**（`read`/`bash` 这条链路，
  `test/smoke2.mjs` 验证了双向改名 + 真实调用成功）；`web_search` 之类只验证了
  「能声明、不破坏门禁」，没验证上游真的会执行它。

---

## 四、安装

**一条命令，装完重启就完事。** 不需要手改 `package.json`，不需要手改 `bundles`——
DSH 在 `dsh plugin add` 成功后会自动把声明了 `dsh.bundle.patch` 的新依赖追加进
`dsh.profile.bundles`，插件因此自动生效。

### 方式 A：`dsh plugin`（推荐）

```powershell
dsh plugin --profile desktop add "dsh-opencodehub@github:ki11a-Conton/dsh-opencodehub"
```

把 `desktop` 换成你自己的 profile 名（`dsh web` 用 `web`，桌面端用 `desktop`）。
然后**重启 DSH**。搞定。

> 首次装 GitHub 源会慢（实测约 2 分钟，pnpm 要拉 tarball），耐心等。

### 方式 B：在 profile 目录里直接 pnpm

```powershell
cd C:\Users\MECHREV\.dsh\profiles\desktop
pnpm add "dsh-opencodehub@github:ki11a-Conton/dsh-opencodehub"
```

效果和方式 A 相同（`dsh plugin` 就是转发给 pnpm 并顺手 reconcile bundles）。
如果你绕开 `dsh plugin` 用了别的包管理器，才需要手动把 `"dsh-opencodehub"` 加进
`package.json` 的 `dsh.profile.bundles` 数组：

```jsonc
"dsh": {
  "profile": {
    "bundles": [
      "@deepseek-ai/dsh-base",
      "@deepseek-ai/dsh-web-app",
      // ...
      "dsh-opencodehub"        // ← 只有手动装时才需要加这一行
    ]
  }
}
```

### 方式 C：从 Release 压缩包装

下载 [最新 Release 的 zip](https://github.com/ki11a-Conton/dsh-opencodehub/releases)，解压到任意目录。
解压后会得到一个 `dsh-opencodehub\` 文件夹（里面是 `lib/`、`package.json`、`cordis.patch.yml`）。

**`file:` 路径要指向这个子文件夹，不是它的父目录**：

```powershell
dsh plugin --profile desktop add "file:D:/你的解压路径/dsh-opencodehub"
```

> 2026-10-19 之前上传的 zip 是扁平结构（`index.js` 直接在根目录），装完会找不到
> `lib/index.js` 而失败。现已替换为正确结构，如果你手上的包解压后根目录就有 `index.js`，
> 请重新下载。

### 方式 D：从本地目录装（开发用）

```powershell
dsh plugin --profile desktop add "file:D:/Download games/dsh插件/dsh-opencodehub"
```

### 装完要不要重启？

**要，且只需一次。** DSH 的补丁层（`cordis.patch.yml`）和 bundle 列表在启动时合成，
不支持热更新。插件代码本身有热重载能力，但**首次注册**（让 `opencodehub` 出现在模型目录里、
并让默认模型那一行生效）必须重启一次。

### 卸载

```powershell
dsh plugin --profile desktop remove dsh-opencodehub
```

`dsh plugin` 会同时把它从 `dsh.profile.bundles` 里摘掉；重启后 `opencodehub` 分组消失，
默认模型回落到 DSH 官方。如果你的 profile 补丁层里手写过 `agent-default-model`
指向 `opencodehub`，记得一并删掉，否则新会话会因为找不到提供方而失败。

---

## 五、配置项（Config）

全部有默认值，**零配置可用**。要改就在 profile 补丁层里按 id 覆盖（见上文代理一节）。

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

> **注意**：按 id 覆盖时 config 是**整体替换，不是深合并**（DSH 补丁层的规则）。但没写的键不会报错
> ——它们会回落到 schema 里的 `.default()`。所以只写你要改的那一个键就够了。
> 本插件的 config 只有上表这 8 个键，别把别的插件那套结构抄过来。

---

## 六、移植了什么（对应 Go 源）

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
- **装完即用**（DSH 侧新增，无 Go 对应物）：bundle 补丁层把 `agent-default-model` 指向
  `opencodehub` / `beam-free`，新会话默认走 Zen 免费层，无需用户手改 YAML。这是本插件
  相对上游的**功能增强**——上游是独立网关进程，路由由 CPA 配置决定；在 DSH 里必须靠补丁层
  才能做到「装上就能用」。
- **错误语义**：200 包错误对象、聚合不出内容、无 finish 的流均映射为带稳定 code 的 LlmError
  （AUTH/RATE_LIMIT/SERVER/TIMEOUT/TRANSPORT/EMPTY_RESPONSE…）。

## 七、与原版的刻意偏差

- **归因头**：dsh-llm 适配器契约要求每个上游请求带 `attributionHeaders()`（`user-agent:
  deepseek-harness/...`），但 Zen 以 UA 参与门禁指纹，发送会 403。本适配器按协议仿真优先，
  发送 opencode CLI 原版 UA；此偏差为已知且有意。
- **目录轮询**：Go 原版后台每 10 分钟拉一次目录；这里改为 `listModels()` 惰性拉取 + TTL 缓存
  （无后台定时器，行为等价）。
- **管理面板**：CPA 的只读管理页不移植；配置走 DSH 插件 Config schema。

## 八、开发与验证

```bash
# 离线单测（不发网络请求）
node test/unit.mjs

# 实弹：文本流（需要代理可用）
node test/smoke.mjs

# 实弹：工具调用回合（Read 门禁改名 + 参数流式）
node test/smoke2.mjs

# 实弹：死代理降级（拨号失败 → 挂起 → 直连成功）
node test/smoke3.mjs
```

本机（2026-10-19）四个测试全部通过；已安装进 desktop profile 并验证 loader `phase=active`。

运行时依赖解析：`undici`、`@deepseek-ai/schemastery` 来自 profile hoisted node_modules；
`@deepseek-ai/cordis` 仅为 peerDep 声明，运行时不 import。

## 变更记录

- **0.1.3（装完即用）**：bundle 补丁层新增 `agent-default-model` 覆盖，新会话默认走
  `opencodehub/beam-free`——装完插件 + 重启 DSH 即可直接对话，不需要手改任何 YAML。
  实测验证：全新 profile 里 `dsh plugin add` 后 `--dump-config` 显示默认模型已变为
  `opencodehub/beam-free`，headless 一次性问答返回正常（无任何凭据、无任何手改）。
- **0.1.2（对齐上游 1e7eed54）**：出口被拒时自愈——403 FreeTierError 挂起代理 10 分钟改直连
  （无退避立即重试）；代理拨号失败挂起 5 分钟；目录拉取共享同一出口决策；`egressLabel()` 对应
  Go `transportLabel`。版本号 `0.1.0` → `0.1.2`。新增 `test/smoke3.mjs`。
- **0.1.0**：初版移植（对齐上游 0.1.1 / d11b6e67）。

## License

MIT（见 `package.json`）。本插件是 [opencodehub](https://github.com/ki11a-Conton/opencodehub) 的移植，
上游为同一作者的项目；协议复刻部分的实现细节均来自上游 Go 源码。
