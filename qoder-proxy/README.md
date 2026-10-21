# qoder-proxy

把 Qoder 账号里限时免费的模型(DeepSeek-Flash、Qwen3.8-Flash)反代成 **OpenAI 兼容接口**,给任意 AI 客户端(Codex、Cherry Studio、NextChat 等)使用。

- 零依赖,单文件,Node.js ≥ 18
- 完整实现 Qoder 上游 COSY 协议(RSA+AES 会话、MD5 请求签名、自定义 base64 编码)
- 流式 / 非流式 `chat/completions`、工具调用(tool_calls 分片合并)、reasoning_content 透传
- 凭证失效自动用 refreshToken 续期

## 快速开始

```bash
# 1. 导入登录态(自动从本机 Qoder IDE 读取,仅 macOS;
#    会弹一次钥匙串授权,选"始终允许")
node qoder-proxy.mjs login

# 2. 启动
node qoder-proxy.mjs serve --port 8477

# 带 API key 保护(公网部署强烈建议)
node qoder-proxy.mjs serve --port 8477 --host 0.0.0.0 --key <你的密钥>
```

非 macOS / 无 IDE 的环境,手动放凭证:

```bash
mkdir -p ~/.qoder-proxy
cat > ~/.qoder-proxy/auth.json <<'EOF'
{"token":"dt-...","refreshToken":"drt-..."}
EOF
chmod 600 ~/.qoder-proxy/auth.json
```

也可以用环境变量:`QODER_TOKEN` / `QODER_REFRESH_TOKEN`(优先级高于 auth.json)。

## 接口

| 端点 | 说明 |
|---|---|
| `POST /v1/chat/completions` | OpenAI 兼容,支持 stream、tools、多轮 |
| `GET /v1/models` | 实时拉取上游模型目录(含 `free` 标记) |
| `GET /health` | 健康检查 |

## 模型

`GET /v1/models` 返回账号当前完整目录。免费模型(`free: true`):

| 模型 key | 别名(都指向它) | 说明 | 免费截止 |
|---|---|---|---|
| `dfmodel` | `deepseek` / `deepseek-v4.1-flash-1017` / `ds` / `auto` / `default` | DeepSeek-Flash(V4.1-Flash-1017),带推理,max 档 | 2026-10-25 |
| `qfmodel` | `qwen` / `qwen3.8-flash` | Qwen3.8-Flash,带推理,medium 档 | 限时免费 |

> 签到每天可领 100 Credits(30 天有效,全模型可用),跑 `node qoder-proxy.mjs checkin`;
> 有 Credits 后 0.1 费率的模型(`gfmodel`/`qmodel`/`mmodel`)也可用。

请求里的 `model` 字段填上游 key 或别名均可;不传默认 `dfmodel`。

### 推理档位(思考开关)

默认**开启思考并跑 `max` 档**。两种控制方式:

```bash
# 方式一: 模型名后缀
"model": "deepseek-v4.1-flash-1017:low"     # low / medium / high / xhigh / max / off
# 方式二: OpenAI 风格字段
"reasoning_effort": "low"                    # 或 "reasoning": {"effort": "low"}
```

后缀优先级高于请求体字段。注意:`off` 只是尽力压制(实测上游对免费模型强制保留少量思考),
要最快响应用 `:low`。

```bash
curl http://127.0.0.1:8477/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"deepseek-v4.1-flash","messages":[{"role":"user","content":"hi"}]}'
```

## 接入客户端

- **Codex / OpenAI SDK**: base_url = `http://127.0.0.1:8477/v1`,api_key 任意(或启动时 `--key` 指定的值),model = `deepseek-v4.1-flash`

## 实现说明

- 登录态来自 Qoder IDE 本地凭证(`auth.v1.dat`,Electron safeStorage 加密,macOS 钥匙串取密钥按 Chromium safe_storage 算法解密);`dt-` 设备令牌直接构造 COSY 会话,`drt-` 刷新令牌用于过期续期
- 设备指纹由账号 UID 单向哈希派生(稳定不漂移)
- 上游 `agent_chat_generation` 仅支持流式,非流式由代理聚合;信封错误(418/429/5xx)自动退避重试

## 通道说明(重要)

Qoder 有两套推理网关,免费账号待遇不同:

| 网关 | 说明 |
|---|---|
| `api2.qoder.sh` | **官方客户端选举的推理入口**,免费账号正常使用,无每日次数限制 ✅ 本代理默认 |
| `api1.qoder.sh` | 第三方客户端常用入口,免费账号有**每日次数限制**(超限报 `403 code 110 "Billing daily count exceeded"`)⚠️ |

认证令牌有三个层级,本代理自动处理:

| 令牌 | 有效期 | 用途 |
|---|---|---|
| `dt-` 设备令牌 | ~30 天 | 登录态本体,从 IDE 导入 |
| `drt-` 刷新令牌 | ~1 年 | dt- 过期后续期 |
| `jt-` 工作令牌 | 24 小时 | IDE 通道凭证,启动时用 dt- 调 `/api/v1/me/jobToken` 现签,自动缓存续期 |

签到领的 Credits(每天 100,30 天有效)在所有通道通用。

## 免责

仅供学习研究。免费额度、接口和签名算法以 Qoder 官方策略为准,随时可能变化;请遵守 Qoder 服务条款。
