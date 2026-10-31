# GitHub Copilot for Coda

用 GitHub Copilot CLI 的原生 `--acp --no-auto-update` 接入 Coda 的社区插件（非 GitHub 或 Coda 官方）。`private: true` 只为防止误发 npm；通过 Git 仓库安装。

## 安装

在 Coda「设置 › 插件 › 从仓库添加…」（iPhone 在插件页右上角的「＋」里）填写：

- 仓库：`https://github.com/xingzhuimeteorite/coda-plugin-copilot.git`
- 分支／版本：留空（默认分支 `main`）
- 目录：留空，插件在仓库根目录。

读取后选择 GitHub Copilot 并按 Coda 的安装确认完成安装。安装后新建会话，选择 **GitHub Copilot**，工作模式选择 **Autopilot**。资源页同时出现「GitHub Copilot」额度面板。

已有安装可在「设置 › 插件 › GitHub Copilot」右上角「⋯」中检查更新。安装确认会列出插件要运行的命令（setup 会把 `@github/copilot` 装进插件状态目录），确认即批准。

## 运行方式

- Coda 使用 `$CODA_NODE` 启动 `agent/entry.mjs`；不调用 login shell。
- 先在 `CODA_USER_PATH`（Coda 提供的真实用户 PATH；没有时用 PATH）查找 `copilot`，排除空／相对路径项。
- 否则使用 `$CODA_PLUGIN_STATE/cli` 的 Copilot。setup 使用 Coda Node 附带的 npm 安装 `@github/copilot@1.0.105`，固定为本次验收版本；不全局安装。若没有 Coda 自带 npm，再查实际用户 PATH 中的 npm。
- fallback 直接启动 npm 包中的平台原生 binary，避免 npm-loader 的同步子进程阻碍退出信号。无可运行 CLI 时明确报错，不在每个会话里下载。
- 所有会话都加 `--no-auto-update`。CLI 使用原来的 Copilot 登录和配置，不复制或读取令牌。
- 当前机器可通过实际用户 PATH 中的 `gh` 复用登录。去掉 `/opt/homebrew/bin` 的极简 PATH 在本次测试中导致 `session/new` 返回 Authentication required，恢复实际用户 PATH 后成功。不要假设随意裁剪 PATH 后仍有认证。
- 首次需要登录时，用运行机的 `copilot login`；若未全局安装，用 Coda setup 输出的 CLI 路径加 `login`。也可以在终端运行 `npx -y @github/copilot@1.0.105 login`。凭据由 Copilot 自己保存。

## 审批档位

`modes.auto` 和 `modes.full` 都声明为：

```text
https://agentclientprotocol.com/protocol/session-modes#autopilot
```

当前 Coda schema 允许同值，实际 `delegateMode` 已验证：父会话在自身 auto/full 时，给子 Agent 的是子 Agent 声明的 auto；人工审批的父会话不能指定自主子会话，其他 Agent 的 full 也不能被子会话越级请求。

Copilot 在此没有两个不同权限级别：auto/full 都代表实验性 autopilot，它会打开 allow-all 并持续执行到任务完成。Coda 的审批档位声明不会为 Copilot 增加沙箱，也不会修改其他 Agent 的权限。

未选择模式时沿用 Copilot 原生会话默认值（本次新会话为 agent）；`unset: 人工审批` 是 Coda 的显示标签，不会强制覆盖运行机的权限配置。

## 薄适配的边界

Copilot 1.0.105 没有声明 ACP `systemPrompt`。插件复用官方 Grok 的 MIT `SessionInstructions`：声明支持 append 文本指令，在新会话的第一条非斜杠 prompt 前放一段明确分隔的 Coda 指令；之后不重复，恢复会话不重复注入。若未来上游原生支持，则直接转发。这个方式的指令强度低于真正的系统／developer 指令。

mode、model、reasoning_effort、allow_all，以及 ACP 工具、通知、请求与答复原样转发；不合成模式、不去重正文、不加入模型分组或持久化观察器。

skills 使用 `.agents/skills`，是 [Copilot 官方支持的项目 skill 目录](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/add-skills)。`configFiles` 跟踪用户及项目的 settings.json / settings.local.json，供 Coda 在配置变化时刷新探测。

本插件未接入 Coda `_coda/wait` 的原生后台任务／原生子 Agent 观测与独立停止；Coda 自身通过 MCP 开出的子会话仍按核心规则传递 auto。不要把这两种子会话机制混为一谈。

0.1.0 验收中的唯一真实 prompt 收到 `end_turn`，ACP 文本拼接为 `OKOK`。原生事件记录为一条 assistant 正文 `OK`，紧接 `task_complete(summary=OK)`；插件保留上游内容，未做特殊归并。

## MCP stdio → Streamable HTTP 桥（0.2.0）

Copilot CLI 1.0.105 的 ACP 拒绝客户端 stdio MCP。entry 在转发带 `params.mcpServers` 的请求前启动本机桥，包括 schema 中的 `session/new`、`session/load`、`session/resume`、`session/fork`；现有 http/sse 项保持原样。

```js
// Coda → entry
{ name: 'coda', command: '/path/to/node', env: [],
  args: ['/runtime/src/adapters/mcp-shim.mjs', '--thread', 'thread-id', '--socket', '/path/to/socket'] }
// entry → Copilot
{ type: 'http', name: 'coda',
  url: 'http://127.0.0.1:<随机端口>/mcp/<随机token>', headers: [] }
```

- 仅 Node 内置模块。每项启动一个 stdio 子进程和 loopback HTTP 服务，合并当前环境与 ACP `env: [{name,value}]`，使用会话 cwd。相同 name/command/args/env 在插件进程内复用一个桥；首次 cwd 保留到退出。不同配置不共用子进程。
- POST 支持单请求、旧版 MCP 2025-03-26 的 batch（批量）、通知和响应（202 空正文）。初始化成功发放随机 `Mcp-Session-Id`，后续请求必须携带；未知 session 返回 404，缺少返回 400。每个 HTTP session 内不允许重复的在途 ID；不同 session 的相同 ID 会映射为不同 stdio ID。取消通知中的 requestId 同步映射。
- 默认 `application/json`；Accept 只接受 `text/event-stream` 时以单个 message 事件返回。无需额外 ACP headers；Copilot 1.0.105 默认 HTTP 请求已实测成功。客户端需回传 Mcp-Session-Id；协议版本 header 若提供，则按 stdio initialize 结果校验，不匹配返回 400。
- GET/DELETE 返回 405。没有服务器主动通知流、SSE 重连/重放；stdio 主动通知不转发，主动请求立即收到 -32601。不适用于要求 sampling、elicitation、roots/list 等客户端能力的 MCP 服务器；本桥不会实现这些能力。工具列表变动需要客户端主动重新 list 或重开会话。
- 不给工具调用设置 HTTP socket/request 超时；headersTimeout 为 120 秒。POST 正文最多 16 MiB。只监听 127.0.0.1，随机 URL token；有 Origin 时只接受自身 origin，不开放 CORS。
- stop、stdin EOF、TERM/INT/HUP、Copilot 退出都会关闭 HTTP 服务及 stdio 子进程，800ms 后仍未结束则 KILL。stdio 意外退出会结束在途请求并使后续调用返回 503；不自动重启，需重开插件进程。强制 SIGKILL 或系统崩溃无法执行清理。
- 复用桥也意味着复用同一 stdio 服务器的状态；同一配置跨不同 cwd 不提供进程隔离，首次 cwd 生效。不同 HTTP session 各自初始化，要求 stdio 服务器允许重新 initialize；Coda shim 的配置包含 thread/socket，通常已按线程区分。

依据：[当前 Coda ACP schema](https://agentclientprotocol.com/protocol/session-setup)、[MCP 2025-03-26 transports](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports)、[MCP 2025-06-18 transports](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)。后续 MCP 版本已移除 batch；这里保留旧版兼容，不向 Copilot 主动发送 batch。

## 资源页额度面板（0.3.0）

插件在资源页带「GitHub Copilot」面板（`contributes.panels` 的 `quota`），显示这台机器上 Copilot CLI 登录账号的 AI Credits 额度：剩余进度条与重置时间、本月已用，超出套餐时另列一行。
额度属于 Agent 自己的登录，按 Coda 的做法（官方 Codex、Claude、Kimi 插件）随 Agent 插件提供，不另起插件。

- **身份**：用同一个 Copilot CLI 的无界面 JSON-RPC（`--headless --stdio`，@github/copilot-sdk 用的通道）问 `auth.getStatus`，得到 Copilot 实际使用的账号与认证来源，问完即关。
- **额度**：用这份凭据实时读 GitHub 的 `/copilot_internal/user`（`quota_snapshots.premium_interactions`、`quota_reset_date_utc`），并核对账号与 Copilot 一致。
  - 认证来自 gh（`gh-cli`）时由 `gh api --hostname <主机>` 代查，令牌不经过脚本；
  - 来自环境变量（`env`）时按 Copilot 的顺序 `COPILOT_GITHUB_TOKEN`、`GH_TOKEN`、`GITHUB_TOKEN` 取令牌直接请求；
  - 来自 `copilot login`（`user`）时不读取 Copilot 存在钥匙串里的凭据，卡片写明没有实时额度。
- Copilot 自己的 `account.getQuota` 是缓存快照，实测停在旧值、`resetDate` 不是重置时间，所以不用。`--headless`、`auth.getStatus` 与 `/copilot_internal/user` 都不是公开稳定接口，升级 CLI 时复核。
- 未登录时输出为空，面板不显示。身份写作 `github-copilot:<login>`。`maxAge` 5 分钟，资源页「刷新」总是重读；没有自定义按钮。

## 验证与维护

入口运行时只用 Node 内置模块，不引用 Coda 的后端代码或官方插件安装目录。`agent/instructions.mjs` 是本地副本，保留 MIT 授权。

```sh
# 使用 Node 24+；这些本地测试不消耗 Copilot 额度。
node --test test/local.test.mjs test/mcp-bridge.test.mjs test/panel.test.mjs

# 只读核对实际 Coda schema、加载与子会话传递。
CODA_RUNTIME=/path/to/coda/release node test/coda-contract.mjs

# 官方检查器；--manifest 不启动 CLI，默认握手也不发送 prompt。
coda-plugin-check . --manifest
coda-plugin-check . --agent copilot
```

真实 smoke test 必须显式设置 `CODA_PLUGIN_STATE` 为独立测试状态目录、`COPILOT_TEST_EVIDENCE` 为独立证据目录，再运行 `node test/smoke.mjs`。若测试状态没有 CLI，先在相同状态下运行 `node scripts/setup.mjs`。测试会发送一个真实 prompt；它用证据目录内的 `prompt-sent.lock` 防止在同一目录重发。不要用官方检查器的 `--live` 补跑，因为它会发送多轮 prompt。

`test/smoke.mjs` 验收原生握手、Coda 指令声明、autopilot 更新、一次 prompt 的结束与 OK 内容；同时记录 `exactReply`，保留重复或额外正文，不能以此隐藏上游输出差异。本次最初的严格单个 OK 断言失败已在记录中保留，没有重新发送 prompt。

`python3 scripts/build-icons.py` 可用 reportlab 再生成 light/dark PDF；它不是运行依赖。图标是原创通用机器人／护目镜图案，不是 GitHub 官方品牌图形。

升级 CLI 时修改 `agent/binary.mjs` 的固定版本，再按需验证。PATH 上已有的 CLI 优先且版本由运行机管理；setup 只确认它能报版本，不自动改动全局安装。现存状态目录 CLI 也直接复用；升级现有状态副本需另行明确执行对应 npm install。

MCP 真实握手（不发 prompt）：显式设置独立的 `CODA_PLUGIN_STATE` 和正常 `CODA_USER_PATH` 后运行 `node test/mcp-copilot.mjs`。默认记录到 `validation/mcp-copilot-result.json`；从新 Copilot process 日志确认 fixture 初始化、读取 tools/list、无 stdio 拒绝，并核对子进程清理。
