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

| 模型 key | 别名(都指向它) | 说明 |
|---|---|---|
| `dfmodel` | `deepseek` / `deepseek-flash` / `deepseek-v4.1-flash` / `ds` / `auto` / `default` | DeepSeek-Flash,限时免费 |
| `qfmodel` | `qwen` / `qwen-flash` / `qwen3.8-flash` | Qwen3.8-Flash,限时免费 |

请求里的 `model` 字段填上游 key 或别名均可;不传默认 `dfmodel`。

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

## 免责

仅供学习研究。免费额度、接口和签名算法以 Qoder 官方策略为准,随时可能变化;请遵守 Qoder 服务条款。
