#!/usr/bin/env node
/**
 * qoder-proxy — 把 Qoder 账号里限时免费的模型(DeepSeek-Flash / Qwen3.8-Flash 等)
 * 反代成 OpenAI 兼容接口。零依赖,Node.js >= 18。
 *
 * 用法:
 *   node qoder-proxy.mjs serve [--port 8477] [--host 127.0.0.1] [--key <apikey>]
 *   node qoder-proxy.mjs login           # 从本机 Qoder IDE 导入登录态(macOS)
 *   node qoder-proxy.mjs models          # 打印当前账号可用模型
 *
 * 凭证优先级: 环境变量 QODER_TOKEN(+QODER_REFRESH_TOKEN) > ~/.qoder-proxy/auth.json
 */
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

// ======================== cosy 协议 (签名/编码/会话) ========================
const CUSTOM = "_doRTgHZBKcGVjlvpC,@aFSx#DPuNJme&i*MzLOEn)sUrthbf%Y^w.(kIQyXqWA!";
const STD = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const s2c = {};
for (let i = 0; i < 64; i++) s2c[STD[i]] = CUSTOM[i];
s2c['='] = '$';

function cosyEncode(plainBuf) {
  const std = plainBuf.toString('base64');
  const n = std.length, a = Math.floor(n / 3);
  const re = std.slice(n - a) + std.slice(a, n - a) + std.slice(0, a);
  return [...re].map(c => s2c[c]).join('');
}

const APP_CODE = 'cosy';
const SECRET_B64 = 'd2FyLCB3YXIgbmV2ZXIgY2hhbmdlcw==';
const COSY_VERSION = '1.0.10';
const md5hex = s => crypto.createHash('md5').update(s).digest('hex');
const uuid = () => crypto.randomUUID();
const unixSec = () => Math.floor(Date.now() / 1000);

const SERVER_PUB = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;

function fingerprint(uid) {
  const m = s => crypto.createHash('md5').update(s).digest('hex');
  return {
    machineId: m('machine:' + uid),
    machineType: m('machinetype:' + uid).slice(0, 18),
    machineToken: crypto.createHash('sha512').update('machinetoken:' + uid).digest('base64url').slice(0, 43),
  };
}

function newSession(identity) {
  const tempKey = crypto.randomBytes(16).toString('hex').slice(0, 16);
  const cosyKey = crypto.publicEncrypt(
    { key: SERVER_PUB, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(tempKey)).toString('base64');
  const payloadJson = JSON.stringify({
    name: identity.name, aid: identity.uid, uid: identity.uid, yx_uid: '',
    organization_id: identity.organizationId || '', organization_name: '',
    user_type: identity.userType || 'personal_standard',
    security_oauth_token: identity.securityOauthToken, refresh_token: identity.refreshToken || '',
  });
  const cipher = crypto.createCipheriv('aes-128-cbc', Buffer.from(tempKey), Buffer.from(tempKey));
  const info = Buffer.concat([cipher.update(payloadJson, 'utf8'), cipher.final()]).toString('base64');
  return { tempKey, cosyKey, info, identity };
}

function buildHeaders(sess, fp, pathSig, bodyStr, accept, extra = {}) {
  const payloadB64 = Buffer.from(JSON.stringify({
    cosyVersion: COSY_VERSION, ideVersion: '', info: sess.info, requestId: uuid(), version: 'v1',
  })).toString('base64');
  const date = String(unixSec());
  const sig = md5hex(payloadB64 + '\n' + sess.cosyKey + '\n' + date + '\n' + bodyStr + '\n' + pathSig);
  return {
    'cosy-data-policy': 'agree',
    'content-type': 'application/json',
    'cosy-machinetype': fp.machineType,
    'cosy-clienttype': '5',
    'cosy-date': date,
    'cosy-user': sess.identity.uid,
    'cosy-key': sess.cosyKey,
    'cache-control': 'no-cache',
    'accept': accept,
    'authorization': 'Bearer COSY.' + payloadB64 + '.' + sig,
    'cosy-version': COSY_VERSION,
    'cosy-machineid': fp.machineId,
    'cosy-machinetoken': fp.machineToken,
    'login-version': 'v2',
    'user-agent': 'Go-http-client/2.0',
    'cosy-scene': 'assistant',
    'cosy-business-product': 'ide',
    'cosy-business-type': 'agent',
    ...extra,
  };
}

// ======================== 端点 ========================
const USERINFO_URL = 'https://openapi.qoder.sh/api/v1/userinfo';
const JOBTOKEN_URL = 'https://center.qoder.sh/algo/api/v3/user/jobToken?Encode=1';
const MODEL_LIST_URL = 'https://api2.qoder.sh/algo/api/v2/model/list?Encode=1';
const CHAT_URL = 'https://api1.qoder.sh/algo/api/v2/service/pro/sse/agent_chat_generation?FetchKeys=llm_model_result&AgentId=agent_common&Encode=1';
const CHAT_PATH_SIG = '/api/v2/service/pro/sse/agent_chat_generation';
const ML_PATH_SIG = '/api/v2/model/list';

// ======================== 凭证管理 ========================
const AUTH_DIR = path.join(os.homedir(), '.qoder-proxy');
const AUTH_FILE = path.join(AUTH_DIR, 'auth.json');

function loadAuth() {
  if (process.env.QODER_TOKEN) {
    return { token: process.env.QODER_TOKEN, refreshToken: process.env.QODER_REFRESH_TOKEN || '' };
  }
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return null; }
}
function saveAuth(a) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(a, null, 2), { mode: 0o600 });
}

// 从本机 Qoder IDE(macOS)导入: auth.v1.dat 用 Electron safeStorage 加密,
// 密钥在 Keychain "Qoder App Safe Storage"(Chromium safe_storage 算法)。
function importFromIDE() {
  const dat = path.join(os.homedir(), 'Library/Application Support/com.qoder.app.stable/auth.v1.dat');
  const pw = execSync('security find-generic-password -s "Qoder App Safe Storage" -w', { encoding: 'utf8' }).trim();
  const key = crypto.pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
  const buf = fs.readFileSync(dat);
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
  const plain = Buffer.concat([d.update(buf.subarray(3)), d.final()]).toString('utf8');
  const j = JSON.parse(plain);
  return { token: j.token, refreshToken: j.refreshToken || '' };
}

// 用 refreshToken 换新的访问令牌(jobToken 交换)
async function refreshTokens(auth) {
  const date = new Date().toUTCString();
  const sig = md5hex(APP_CODE + '&' + SECRET_B64 + '&' + date);
  const inner = JSON.stringify({
    personalToken: '', securityOauthToken: '', refreshToken: auth.refreshToken,
    needRefresh: true, authInfo: {},
  });
  const body = cosyEncode(Buffer.from(JSON.stringify({ payload: inner, encodeVersion: '1' })));
  const seed = 'cred:' + auth.refreshToken;
  const fp = fingerprint(seed);
  const resp = await fetch(JOBTOKEN_URL, {
    method: 'POST',
    headers: {
      'cosy-machinetoken': fp.machineToken, 'cosy-machinetype': fp.machineType,
      'login-version': 'v2', 'appcode': APP_CODE, 'accept': 'application/json',
      'accept-encoding': 'identity', 'cosy-version': COSY_VERSION, 'cosy-clienttype': '5',
      'date': date, 'signature': sig, 'content-type': 'application/json',
      'cosy-machineid': fp.machineId, 'user-agent': 'Go-http-client/2.0',
    },
    body,
  });
  if (!resp.ok) throw new Error('jobToken refresh HTTP ' + resp.status + ': ' + (await resp.text()).slice(0, 200));
  const j = await resp.json();
  if (!j.securityOauthToken) throw new Error('jobToken refresh: no securityOauthToken in response');
  const out = { token: j.securityOauthToken, refreshToken: j.refreshToken || auth.refreshToken };
  saveAuth(out);
  return out;
}

// ======================== 上游会话 ========================
let AUTH = null;       // {token, refreshToken}
let IDENTITY = null;   // userinfo 派生
let SESS = null;       // cosy session
let FP = null;         // 设备指纹

async function initSession(forceRefresh = false) {
  if (!AUTH) {
    AUTH = loadAuth();
    if (!AUTH || !AUTH.token) throw new Error('未找到凭证: 设 QODER_TOKEN 或先运行 `node qoder-proxy.mjs login`');
  }
  if (forceRefresh && AUTH.refreshToken) AUTH = await refreshTokens(AUTH);
  const resp = await fetch(USERINFO_URL, { headers: { authorization: 'Bearer ' + AUTH.token } });
  if (resp.status === 401 && !forceRefresh && AUTH.refreshToken) return initSession(true);
  if (!resp.ok) throw new Error('userinfo HTTP ' + resp.status);
  const ui = await resp.json();
  IDENTITY = {
    name: ui.name, uid: ui.id, organizationId: ui.organization_id || '',
    userType: ui.userType || 'personal_standard',
    securityOauthToken: AUTH.token, refreshToken: AUTH.refreshToken || '',
  };
  SESS = newSession(IDENTITY);
  FP = fingerprint(ui.id);
  return ui;
}

// ======================== 模型目录 ========================
const FALLBACK_MODELS = [
  { key: 'dfmodel', display_name: 'DeepSeek-Flash', is_reasoning: true, price_factor: 0, enable: true },
  { key: 'qfmodel', display_name: 'Qwen3.8-Flash', is_reasoning: true, price_factor: 0, enable: true },
];
const MODEL_ALIASES = {
  'deepseek': 'dfmodel', 'deepseek-flash': 'dfmodel', 'deepseek-v4.1-flash': 'dfmodel',
  'deepseek-v4.1-flash-1017': 'dfmodel',
  'deepseek-v4-flash': 'dfmodel', 'ds-flash': 'dfmodel', 'ds': 'dfmodel',
  'qwen': 'qfmodel', 'qwen-flash': 'qfmodel', 'qwen3.8-flash': 'qfmodel',
  'auto': 'dfmodel', 'default': 'dfmodel',
};
// /v1/models 只展示这两个免费模型(key -> 对外 id)
const PUBLIC_MODEL_IDS = { dfmodel: 'deepseek-v4.1-flash-1017', qfmodel: 'qwen3.8-flash' };
let modelCache = { at: 0, models: null };

async function getModels() {
  if (modelCache.models && Date.now() - modelCache.at < 5 * 60 * 1000) return modelCache.models;
  try {
    const h = buildHeaders(SESS, FP, ML_PATH_SIG, '', 'application/json');
    const resp = await fetch(MODEL_LIST_URL, { headers: h });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    const j = await resp.json();
    const arr = j.assistant || j.chat || [];
    if (Array.isArray(arr) && arr.length) {
      modelCache = {
        at: Date.now(),
        models: arr.map(m => ({
          key: m.key, display_name: m.display_name, is_reasoning: !!m.is_reasoning,
          price_factor: m.price_factor ?? 1, enable: !!m.enable,
          max_input_tokens: m.max_input_tokens || 0,
        })),
      };
      return modelCache.models;
    }
  } catch (e) { console.error('[models] 拉取失败,用兜底列表:', e.message); }
  return FALLBACK_MODELS;
}

// 推理档位: 模型名后缀 ":max/:high/:medium/:low/:xhigh/:off",或请求体 reasoning_effort
const VALID_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const DEFAULT_EFFORT = 'max'; // 默认开思考 + max 档

function resolveModel(requested, models) {
  let r = (requested || 'default').trim();
  let effort = null;
  const ci = r.lastIndexOf(':');
  if (ci > 0) {
    const suffix = r.slice(ci + 1).toLowerCase();
    if (suffix === 'off' || suffix === 'no-think' || suffix === 'nothink') { effort = 'off'; r = r.slice(0, ci); }
    else if (VALID_EFFORTS.has(suffix)) { effort = suffix; r = r.slice(0, ci); }
  }
  const key = MODEL_ALIASES[r.toLowerCase()] || r;
  const info = models.find(m => m.key === key);
  return { key, effort, info: info || { key, display_name: key, is_reasoning: true, price_factor: 0, enable: true } };
}

// ======================== 消息转换 ========================
function contentToText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map(p => {
      if (typeof p === 'string') return p;
      if (p && p.type === 'text') return p.text || '';
      return '';
    }).join('');
  }
  return content == null ? '' : String(content);
}

function convertMessages(incoming) {
  const out = [];
  let hasSystem = false;
  for (const m of incoming || []) {
    if (!m || typeof m !== 'object') continue;
    const role = m.role;
    if (role === 'system' || role === 'developer') {
      if (hasSystem) { // 多个 system 合并
        out[0].content += '\n\n' + contentToText(m.content);
        continue;
      }
      hasSystem = true;
      out.push({ role: 'system', content: contentToText(m.content) });
      continue;
    }
    if (role === 'user') {
      // Claude 风格 tool_result 块 → role:tool
      if (Array.isArray(m.content) && m.content[0] && m.content[0].type === 'tool_result') {
        for (const b of m.content) {
          if (!b || b.type !== 'tool_result') continue;
          out.push({ role: 'tool', tool_call_id: b.tool_use_id || '', content: contentToText(b.content) });
        }
        continue;
      }
      out.push({ role: 'user', content: contentToText(m.content) });
      continue;
    }
    if (role === 'assistant') {
      const msg = { role: 'assistant', content: '' };
      if (Array.isArray(m.content)) {
        const texts = [], toolCalls = [];
        for (const b of m.content) {
          if (!b) continue;
          if (b.type === 'text') texts.push(b.text || '');
          else if (b.type === 'tool_use') {
            toolCalls.push({
              id: b.id, type: 'function',
              function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
            });
          }
        }
        msg.content = texts.join('');
        if (m.tool_calls) toolCalls.push(...m.tool_calls);
        if (toolCalls.length) msg.tool_calls = toolCalls;
      } else {
        msg.content = contentToText(m.content);
        if (Array.isArray(m.tool_calls) && m.tool_calls.length) msg.tool_calls = m.tool_calls;
      }
      out.push(msg);
      continue;
    }
    if (role === 'tool') {
      out.push({ role: 'tool', tool_call_id: m.tool_call_id || '', content: contentToText(m.content) });
      continue;
    }
  }
  if (!hasSystem) out.unshift({ role: 'system', content: 'You are a helpful assistant.' });
  return out;
}

function latestUserPrompt(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') return messages[i].content;
  }
  return '';
}

// ======================== 上游调用 ========================
function buildUpstreamBody(modelKey, modelInfo, messages, tools, maxTokens, effort) {
  const prompt = latestUserPrompt(messages);
  const nid = uuid();
  const thinking = effort !== 'off';
  const eff = thinking ? (effort || DEFAULT_EFFORT) : 'none';
  const body = {
    request_id: nid, request_set_id: uuid(), chat_record_id: nid,
    stream: true, chat_task: 'FREE_INPUT',
    chat_context: {
      chatPrompt: '',
      extra: {
        context: [],
        modelConfig: { is_reasoning: thinking, key: modelKey, ...(eff ? { effort: eff } : {}) },
        originalContent: { type: 'text', text: prompt },
      },
      features: [], imageUrls: null, text: { type: 'text', text: prompt },
    },
    image_urls: null, is_reply: true, is_retry: false,
    session_id: uuid(), code_language: '', source: 1, version: '3', chat_prompt: '',
    parameters: { max_tokens: maxTokens || 32768 },
    aliyun_user_type: IDENTITY.userType || 'personal_standard',
    session_type: 'qoder', agent_id: 'agent_common', task_id: 'common',
    model_config: {
      key: modelKey, display_name: modelInfo.display_name || modelKey, model: '',
      format: 'openai', is_vl: false, is_reasoning: thinking,
      api_key: '', url: '', source: 'system',
      max_input_tokens: modelInfo.max_input_tokens || 180000,
      ...(eff ? { effort: eff } : {}),
    },
    messages,
  };
  if (tools) body.tools = tools;
  return body;
}

class UpstreamError extends Error {
  constructor(status, detail) { super(`upstream ${status}: ${(detail || '').slice(0, 300)}`); this.status = status; this.detail = detail; }
}
const isTransient = (status, detail) =>
  status === 418 || status === 429 || status >= 500 || /provider_error|rate.?limit|timeout/i.test(detail || '');

// 流式调用上游,逐 delta 回调。返回 {usage}
async function callUpstream(modelKey, modelInfo, messages, tools, maxTokens, effort, onDelta) {
  const body = buildUpstreamBody(modelKey, modelInfo, messages, tools, maxTokens, effort);
  const bodyStr = cosyEncode(Buffer.from(JSON.stringify(body)));
  const maxRetries = 2;
  let lastErr = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1000 * attempt));
    const h = buildHeaders(SESS, FP, CHAT_PATH_SIG, bodyStr, 'text/event-stream',
      { 'x-model-key': modelKey, 'x-model-source': 'system' });
    let resp;
    try {
      resp = await fetch(CHAT_URL, { method: 'POST', headers: h, body: bodyStr });
    } catch (e) { lastErr = e; continue; }
    if (resp.status !== 200) {
      const detail = await resp.text().catch(() => '');
      lastErr = new UpstreamError(resp.status, detail);
      if (resp.status === 401 && attempt === 0 && AUTH.refreshToken) { await initSession(true); continue; }
      if (isTransient(resp.status, detail) && attempt < maxRetries) continue;
      throw lastErr;
    }
    // 读 SSE
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    let emitted = false, envelopeErr = null;
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();
          let wrapper;
          try { wrapper = JSON.parse(data); } catch { continue; }
          if (wrapper.statusCodeValue && wrapper.statusCodeValue !== 200) {
            envelopeErr = new UpstreamError(wrapper.statusCodeValue, wrapper.body || '');
            break;
          }
          const inner = wrapper.body;
          if (!inner || inner === '[DONE]') continue;
          let chunk;
          try { chunk = JSON.parse(inner); } catch { continue; }
          if (chunk.code && !chunk.choices) {
            envelopeErr = new UpstreamError(wrapper.statusCodeValue || 400, inner);
            break;
          }
          if (chunk.usage) {
            usage.prompt_tokens = chunk.usage.prompt_tokens || usage.prompt_tokens;
            usage.completion_tokens = chunk.usage.completion_tokens || usage.completion_tokens;
          }
          for (const ch of chunk.choices || []) {
            const d = ch.delta || {};
            if (d.content || d.reasoning_content || d.tool_calls || d.role) {
              emitted = true;
              onDelta({
                role: d.role, content: d.content || '',
                reasoning: d.reasoning_content || '',
                toolCalls: Array.isArray(d.tool_calls) && d.tool_calls.length ? d.tool_calls : null,
              });
            }
          }
        }
        if (envelopeErr) break;
      }
    } catch (e) {
      lastErr = e;
      if (!emitted && attempt < maxRetries) continue;
      throw e;
    }
    if (envelopeErr) {
      lastErr = envelopeErr;
      if (!emitted && isTransient(envelopeErr.status, envelopeErr.detail) && attempt < maxRetries) continue;
      throw envelopeErr;
    }
    if (!emitted) { lastErr = new Error('upstream empty stream'); if (attempt < maxRetries) continue; throw lastErr; }
    return { usage };
  }
  throw lastErr || new Error('upstream failed');
}

// ======================== HTTP 服务 ========================
const ARGS = process.argv.slice(2);
function argVal(name, dflt) {
  const i = ARGS.indexOf('--' + name);
  return i >= 0 && ARGS[i + 1] ? ARGS[i + 1] : dflt;
}

function openaiChunk(id, created, model, delta, finishReason = null, usage = null) {
  const c = {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) c.usage = usage;
  return c;
}

async function handleChatCompletions(req, res, body) {
  let r;
  try { r = JSON.parse(body); } catch { return jsonErr(res, 400, 'invalid JSON body'); }
  const models = await getModels();
  const { key: modelKey, effort: modelEffort, info: modelInfo } = resolveModel(r.model, models);
  // 档位优先级: 模型名后缀 > reasoning_effort / reasoning.effort > 默认 max
  let effort = modelEffort;
  if (!effort) {
    const re = (typeof r.reasoning_effort === 'string' && r.reasoning_effort)
      || (r.reasoning && typeof r.reasoning.effort === 'string' && r.reasoning.effort) || '';
    const rl = re.toLowerCase();
    if (rl === 'none' || rl === 'off' || rl === 'disable' || rl === 'disabled') effort = 'off';
    else if (VALID_EFFORTS.has(rl)) effort = rl;
  }
  const messages = convertMessages(r.messages);
  const tools = Array.isArray(r.tools) && r.tools.length ? r.tools : null;
  const isStream = r.stream === true;
  const reqId = 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
  const created = unixSec();
  const t0 = Date.now();
  console.log(`[chat] model=${r.model || 'default'}->${modelKey} effort=${effort || DEFAULT_EFFORT} stream=${isStream} msgs=${messages.length} tools=${tools ? tools.length : 0}`);

  if (isStream) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      'Connection': 'keep-alive', 'X-Accel-Buffering': 'no',
    });
    const send = obj => res.write('data: ' + JSON.stringify(obj) + '\n\n');
    let sawToolCalls = false, usage = null;
    try {
      const out = await callUpstream(modelKey, modelInfo, messages, tools, r.max_tokens, effort, d => {
        const delta = {};
        if (d.role) delta.role = d.role;
        if (d.reasoning) delta.reasoning_content = d.reasoning;
        if (d.content) { delta.role = delta.role || 'assistant'; delta.content = d.content; }
        if (d.toolCalls) { delta.tool_calls = d.toolCalls; sawToolCalls = true; }
        send(openaiChunk(reqId, created, modelKey, delta));
      });
      usage = out.usage;
    } catch (e) {
      console.error(`[chat] 上游错误: ${e.message} (${Date.now() - t0}ms)`);
      send({ error: { message: e.message, type: e instanceof UpstreamError ? 'upstream_error' : 'proxy_error' } });
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    const u = usage && (usage.prompt_tokens || usage.completion_tokens)
      ? { prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens, total_tokens: usage.prompt_tokens + usage.completion_tokens }
      : null;
    send(openaiChunk(reqId, created, modelKey, {}, sawToolCalls ? 'tool_calls' : 'stop', u));
    res.write('data: [DONE]\n\n');
    res.end();
    console.log(`[chat] 完成 ${Date.now() - t0}ms in=${u?.prompt_tokens} out=${u?.completion_tokens}`);
  } else {
    let full = '', reasoning = '';
    const toolFrags = new Map(); // index -> 合并中的 tool_call
    try {
      const out = await callUpstream(modelKey, modelInfo, messages, tools, r.max_tokens, effort, d => {
        if (d.content) full += d.content;
        if (d.reasoning) reasoning += d.reasoning;
        if (d.toolCalls) {
          for (const tc of d.toolCalls) {
            const k = tc.index ?? tc.id ?? 0;
            if (!toolFrags.has(k)) toolFrags.set(k, { id: tc.id, type: 'function', function: { name: tc.function?.name || '', arguments: '' } });
            const cur = toolFrags.get(k);
            if (tc.id) cur.id = tc.id;
            if (tc.function?.name) cur.function.name = tc.function.name;
            if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
          }
        }
      });
      const usage = out.usage;
      const toolCallBuf = [...toolFrags.values()];
      const msg = { role: 'assistant', content: full || null };
      if (reasoning) msg.reasoning_content = reasoning;
      let finish = 'stop';
      if (toolCallBuf.length) { finish = 'tool_calls'; msg.tool_calls = toolCallBuf; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: reqId, object: 'chat.completion', created, model: modelKey,
        choices: [{ index: 0, message: msg, finish_reason: finish }],
        usage: {
          prompt_tokens: usage.prompt_tokens, completion_tokens: usage.completion_tokens,
          total_tokens: usage.prompt_tokens + usage.completion_tokens,
        },
      }));
      console.log(`[chat] 完成 ${Date.now() - t0}ms in=${usage.prompt_tokens} out=${usage.completion_tokens}`);
    } catch (e) {
      console.error(`[chat] 上游错误: ${e.message} (${Date.now() - t0}ms)`);
      jsonErr(res, e instanceof UpstreamError ? 502 : 500, e.message);
    }
  }
}

function jsonErr(res, status, msg) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: msg, type: 'proxy_error' } }));
}

async function handleModels(res) {
  const models = await getModels();
  const now = unixSec();
  // 只展示 PUBLIC_MODEL_IDS 里映射的免费模型
  const data = [];
  for (const [key, publicId] of Object.entries(PUBLIC_MODEL_IDS)) {
    const m = models.find(x => x.key === key);
    data.push({
      id: publicId, object: 'model', created: now, owned_by: 'qoder',
      display_name: m?.display_name || publicId, free: true,
      reasoning: m ? m.is_reasoning : true, upstream_key: key,
    });
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ object: 'list', data }));
}

async function serve(port, host, apiKey) {
  await initSession();
  console.log(`[auth] 登录用户: ${IDENTITY.name} (${IDENTITY.uid})`);
  const models = await getModels();
  const free = models.filter(m => m.price_factor === 0 && m.enable);
  console.log(`[models] ${models.length} 个模型,免费可用: ${free.map(m => `${m.key}(${m.display_name})`).join(', ') || '无'}`);

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (apiKey) {
      const auth = req.headers.authorization || '';
      if (auth !== 'Bearer ' + apiKey) return jsonErr(res, 401, 'invalid api key');
    }
    const url = req.url.split('?')[0];
    let body = '';
    req.on('data', c => body += c);
    req.on('end', async () => {
      try {
        if (req.method === 'POST' && url === '/v1/chat/completions') return await handleChatCompletions(req, res, body);
        if (req.method === 'GET' && url === '/v1/models') return await handleModels(res);
        if (url === '/health' || url === '/') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ ok: true, user: IDENTITY.name }));
        }
        jsonErr(res, 404, 'not found: ' + url);
      } catch (e) {
        console.error('[server] 未处理异常:', e);
        if (!res.headersSent) jsonErr(res, 500, e.message);
        else res.end();
      }
    });
  });
  server.listen(port, host, () => {
    console.log(`qoder-proxy  listening on http://${host}:${port}/v1${apiKey ? ' (API key 已启用)' : ''}`);
  });
}

// ======================== CLI ========================
const cmd = ARGS[0] || 'serve';
if (cmd === 'serve') {
  const port = parseInt(argVal('port', '8477'), 10);
  const host = argVal('host', '127.0.0.1');
  const key = argVal('key', process.env.QODER_PROXY_KEY || '');
  serve(port, host, key).catch(e => { console.error('启动失败:', e.message); process.exit(1); });
} else if (cmd === 'login') {
  try {
    const a = importFromIDE();
    saveAuth(a);
    console.log('已从本机 Qoder IDE 导入登录态 →', AUTH_FILE);
  } catch (e) {
    console.error('导入失败:', e.message);
    console.error('也可以手动创建', AUTH_FILE, '内容: {"token":"dt-...","refreshToken":"drt-..."}');
    process.exit(1);
  }
} else if (cmd === 'models') {
  const raw = ARGS.includes('--raw');
  initSession().then(async () => {
    if (raw) {
      const h = buildHeaders(SESS, FP, ML_PATH_SIG, '', 'application/json');
      const resp = await fetch(MODEL_LIST_URL, { headers: h });
      console.log(JSON.stringify(await resp.json(), null, 2));
      return;
    }
    const ms = await getModels();
    for (const m of ms) console.log(`${m.key}\t${m.display_name}\tfree=${m.price_factor === 0 && m.enable}\tprice=${m.price_factor}\treasoning=${m.is_reasoning}`);
  }).catch(e => { console.error(e.message); process.exit(1); });
} else {
  console.log('commands: serve | login | models');
}
