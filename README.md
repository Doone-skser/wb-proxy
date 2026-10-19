# wb-proxy — WorkBuddy 免费大模型反代

把 WorkBuddy(腾讯)账号里限时免费的大模型反代成 OpenAI 兼容接口,供任意 AI 工具使用。

零依赖,只要 Node.js ≥ 18,单文件。

## 免费模型

| 模型 | 说明 | 免费截止 |
|---|---|---|
| `deepseek-v4.1-flash` | DeepSeek 旗舰,1M 上下文,多模态,支持工具调用 | 2026-11-01 |
| `hy3` | 腾讯混元思考模型 | 2026-11-01 |
| `step-5-preview` | 阶跃星辰旗舰 | 2026-10-26 |
| `deepseek-v4.1-flash-sg` | 付费通道(x0.03 积分),免费通道限流时的备胎 | — |

> 以 WorkBuddy 账号内的实际促销为准,免费窗口可能变化。

## 快速开始

```bash
# 1. 登录(一次性,浏览器授权,token 存 ~/.wb-proxy/auth.json,有效期约 1 年)
node wb-proxy.mjs login

# 2. 启动反代
node wb-proxy.mjs serve --port 8377

# 监听公网时必须加 --key 保护(否则拒绝启动)
node wb-proxy.mjs serve --host 0.0.0.0 --port 18777 --key <你的密钥>
```

默认使用国际版 `https://www.workbuddy.ai`。国内版账号可通过环境变量切换到 `https://www.workbuddy.cn`，两种区域的登录凭据互不通用：

```bash
# Windows PowerShell
$env:WB_ENDPOINT = "https://www.workbuddy.cn"
$env:WB_AUTH_FILE = "$HOME\\.wb-proxy\\auth-cn.json"
node wb-proxy.mjs login
node wb-proxy.mjs serve --port 8377
```

国内版目前提供 `deepseek-v4.1-flash`、`hy3` 和 `step-5-preview`；`deepseek-v4.1-flash-sg` 不适用于国内版。`WB_AUTH_FILE` 用于让国内版和国际版使用不同的登录凭据；不设置时仍使用原来的 `~/.wb-proxy/auth.json`。未设置 `WB_ENDPOINT` 时，国际版行为保持不变。

## 端点

- `POST /v1/chat/completions` — OpenAI Chat Completions(流式/非流式都支持)
- `POST /v1/responses` — OpenAI **Responses API**(新版 Codex 等只支持 Responses 的客户端,自动双向翻译)
- `GET /v1/models` — 模型列表
- `GET /health` — 健康检查

## 客户端接入

- baseURL: `http://127.0.0.1:8377/v1`(或你的服务器地址)
- apiKey: 任意值(启动时加了 `--key` 则填该值)
- model: `deepseek-v4.1-flash` 等

### Codex(~/.codex/config.toml)

```toml
model_provider = "custom"
model = "deepseek-v4.1-flash"

[model_providers.custom]
name = "custom"
wire_api = "responses"      # 新版 Codex 只支持 responses, wb-proxy 已兼容
requires_openai_auth = false
base_url = "http://127.0.0.1:8377/v1"
experimental_bearer_token = "1"
```

其他支持自定义 OpenAI baseURL 的工具(CC Switch / Cherry Studio / NextChat / LobeChat 等)同理。

## 实现要点

- 上游 `POST https://www.workbuddy.ai/v2/chat/completions`,OpenAI SSE 格式,仅支持流式;
  非流式请求由代理聚合 SSE 后返回标准 JSON。
- 网关安全策略: 首条消息必须是 system(代理自动补一条,`WB_SYSTEM_PROMPT` 可覆盖),
  不认 `developer` 角色(自动归一为 system);Codex 的并行工具调用会合并成标准
  OpenAI 单条 assistant 多 tool_calls 形态。
- 认证头 `Authorization: Bearer <accessToken>` + `X-User-Id`(自动从 JWT 的 sub 解析);
  token 快过期自动调用 `/v2/plugin/auth/token/refresh` 续期,失效重跑 `login`。
- 完整模拟官方 WorkBuddy CLI 客户端头(`User-Agent: CLI/<v> WorkBuddy AI/<v>`、
  `X-IDE-*` / `X-Agent-*` / `X-CodeBuddy-Request` / `X-Conversation-*` 等),
  否则裸请求会被网关分到更严格的外部限流桶, 容易 429; 残余 429 自动退避重试(4s/10s/20s)。
- 弹性 DNS: 系统 DNS 被 fake-ip VPN(Clash/Surge)劫持且隧道故障时, 自动改用
  阿里 DoH(223.5.5.5)解析真实 IP 直连。
- `WB_DEBUG=1` 启动时会把最近一次上游请求体写到 `~/.wb-proxy/last-request.json` 方便排查。

## 部署到服务器

```bash
scp wb-proxy.mjs user@server:~/
# 在本机 login 后把 token 传上去
scp ~/.wb-proxy/auth.json user@server:~/.wb-proxy/auth.json
```

systemd 单元示例:

```ini
[Service]
ExecStart=/usr/bin/node /home/user/wb-proxy.mjs serve --host 0.0.0.0 --port 18777 --key <密钥>
Restart=always
```

别忘了防火墙放行端口。

## 注意与免责声明

- 免费额度是 WorkBuddy 官方限时促销活动,活动结束后按正常积分计费。
- 429 限流按账号计算,多节点部署不能突破总额度,只是备用接入点。
- 本项目通过官方登录接口获取本人账号 token 并调用其网关,仅供学习研究;
  高频/商用调用可能触发风控或违反服务条款,使用者自行承担风险。
- token 文件在 `~/.wb-proxy/auth.json`(权限 600),勿泄露、勿提交。

## License

MIT
