#!/usr/bin/env node
// wb-proxy.mjs — WorkBuddy 免费 deepseek-v4.1-flash 的 OpenAI 兼容反代
//
// 用法:
//   node wb-proxy.mjs login                  # 浏览器扫码/登录一次, 保存 token 到 ~/.wb-proxy/auth.json
//   node wb-proxy.mjs serve [--port 8377] [--key <local-api-key>]
//
// 客户端接入: baseURL=http://127.0.0.1:8377/v1 , apiKey=<local-api-key 或任意值>, model=deepseek-v4.1-flash
// 同时支持 Chat Completions (/v1/chat/completions) 和 Responses (/v1/responses, Codex 用)

import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { exec } from 'node:child_process';

const ENDPOINT = process.env.WB_ENDPOINT || 'https://www.workbuddy.ai';
const PREFIX = '/v2/plugin';
const CHAT_URL = `${ENDPOINT}/v2/chat/completions`;
const DEFAULT_MODEL = 'deepseek-v4.1-flash';
// 当前 WorkBuddy 限时免费(credit=0)的模型; step-5-preview 促销 2026-10-26 截止, 其余到 2026-11-01
const FREE_MODELS = ['deepseek-v4.1-flash', 'hy3', 'step-5-preview'];
const PAID_MODELS = ['deepseek-v4.1-flash-sg'];
const AUTH_DIR = path.join(os.homedir(), '.wb-proxy');
const AUTH_FILE = path.join(AUTH_DIR, 'auth.json');

// ---------------- 弹性网络层 ----------------
// 本机若有 fake-ip 模式 VPN(Clash/Surge 等), 系统 DNS 会返回 198.18.x.x 假地址,
// 依赖 VPN 隧道转发; 隧道故障时自动改用公共 DoH 解析真实 IP 直连。

const dohCache = new Map();

async function dohResolve(host) {
  if (dohCache.has(host)) return dohCache.get(host);
  const res = await fetch(`https://223.5.5.5/resolve?name=${host}&type=A`, { signal: AbortSignal.timeout(5000) });
  const j = await res.json();
  const ip = j?.Answer?.find(a => a.type === 1)?.data;
  if (!ip) throw new Error('DoH 解析失败: ' + host);
  dohCache.set(host, ip);
  return ip;
}

function httpsRequest(urlStr, { method = 'GET', headers = {}, body = null } = {}, forcedIp = null) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = { method, headers };
    if (forcedIp) {
      opts.servername = u.hostname;
      opts.lookup = (_h, _o, cb) => cb(null, forcedIp, 4);
    }
    const req = https.request(urlStr, opts, resolve);
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

async function resilientRequest(urlStr, opts = {}) {
  try {
    return await httpsRequest(urlStr, opts);
  } catch (e) {
    const host = new URL(urlStr).hostname;
    const ip = await dohResolve(host).catch(() => null);
    if (!ip) throw e;
    return httpsRequest(urlStr, opts, ip);
  }
}

async function readAll(stream) {
  const chunks = [];
  for await (const c of stream) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

async function apiJson(method, p, { body, headers = {} } = {}) {
  const res = await resilientRequest(`${ENDPOINT}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : null,
  });
  const text = await readAll(res);
  let json; try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: res.statusCode, json };
}

// 逐条解析 SSE data: 事件
async function* sseEvents(stream) {
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of stream) {
    buf += dec.decode(chunk, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const raw = buf.slice(0, idx); buf = buf.slice(idx + 2);
      for (const line of raw.split('\n')) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        let ev; try { ev = JSON.parse(payload); } catch { continue; }
        yield ev;
      }
    }
  }
}

// ---------------- auth ----------------

function loadAuth() {
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return null; }
}

function saveAuth(a) {
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(a, null, 2), { mode: 0o600 });
}

async function login() {
  const { json } = await apiJson('POST', `${PREFIX}/auth/state?platform=CLI`, { body: {} });
  const d = json?.data;
  if (!d?.authUrl || !d?.state) { console.error('获取 authUrl 失败:', JSON.stringify(json)); process.exit(1); }
  console.log('\n请用浏览器打开下面链接, 登录你的 WorkBuddy 账号(与桌面 App 同一账号):\n');
  console.log('  ' + d.authUrl + '\n');
  exec(`open ${JSON.stringify(d.authUrl)}`);
  console.log('等待登录完成(最长 10 分钟)...');
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 3000));
    const { json: t } = await apiJson('GET', `${PREFIX}/auth/token?state=${d.state}`);
    const data = t?.data?.data ?? t?.data;
    if (data?.accessToken) {
      const auth = { ...data, savedAt: Date.now() };
      if (!auth.expiresAt && auth.expiresIn) auth.expiresAt = Date.now() + auth.expiresIn * 1000;
      saveAuth(auth);
      console.log(`\n登录成功! token 已保存到 ${AUTH_FILE}`);
      return;
    }
    if (t?.code && t.code !== 11217) { console.error('登录失败:', JSON.stringify(t)); process.exit(1); }
    process.stdout.write('.');
  }
  console.error('\n登录超时'); process.exit(1);
}

async function refreshIfNeeded(auth) {
  if (!auth?.refreshToken) return auth;
  const expiresAt = auth.expiresAt ?? 0;
  if (Date.now() < expiresAt - 120_000) return auth; // 还有 2 分钟以上
  console.log('[auth] accessToken 快过期, 刷新中...');
  const { status, json } = await apiJson('POST', `${PREFIX}/auth/token/refresh`, {
    body: {},
    headers: { 'X-Refresh-Token': auth.refreshToken, Authorization: `Bearer ${auth.accessToken}` },
  });
  const data = json?.data?.data ?? json?.data;
  if (status === 200 && data?.accessToken) {
    const next = { ...auth, ...data, savedAt: Date.now() };
    if (next.expiresIn) next.expiresAt = Date.now() + next.expiresIn * 1000;
    saveAuth(next);
    console.log('[auth] 刷新成功');
    return next;
  }
  console.error('[auth] 刷新失败, 沿用旧 token:', status, JSON.stringify(json).slice(0, 300));
  return auth;
}

// ---------------- 公共 ----------------

const DEFAULT_SYSTEM_PROMPT = process.env.WB_SYSTEM_PROMPT || 'You are a helpful assistant.';

// 从 JWT 里解出用户 id (sub), 网关头要求 X-User-Id
function jwtSub(token) {
  try {
    const p = token.split('.')[1];
    return JSON.parse(Buffer.from(p, 'base64url').toString('utf8')).sub || null;
  } catch { return null; }
}

function sendJson(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

// 模拟官方 WorkBuddy CLI 客户端的完整请求头(从 CODEBUDDY_BASE_URL 抓包获得),
// 网关按渠道分配限流桶, 裸请求会被当成外部调用更容易 429
const CLIENT_VERSION = '2.156.0';
const CONVERSATION_ID = crypto.randomUUID(); // 每个代理进程一个会话 id
function officialClientHeaders() {
  const msgId = crypto.randomUUID().replace(/-/g, '');
  const convReqId = crypto.randomUUID().replace(/-/g, '');
  return {
    'User-Agent': `CLI/${CLIENT_VERSION} WorkBuddy AI/${CLIENT_VERSION}`,
    'X-Requested-With': 'XMLHttpRequest',
    'X-IDE-Type': 'CLI',
    'X-IDE-Name': 'CLI',
    'X-IDE-Version': CLIENT_VERSION,
    'X-Agent-Intent': 'craft',
    'X-Agent-Purpose': 'conversation',
    'X-Agent-Type': 'main',
    'X-CodeBuddy-Request': '1',
    'X-Private-Data': 'true',
    'X-Product': 'SaaS',
    'X-Domain': new URL(ENDPOINT).hostname,
    'X-Conversation-ID': CONVERSATION_ID,
    'X-Request-ID': msgId,
    'X-Conversation-Message-ID': msgId,
    'X-Conversation-Request-ID': convReqId,
    'X-Root-Request-ID': convReqId,
  };
}

async function callUpstream(auth, upstreamBody) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${auth.accessToken}`,
    Accept: 'text/event-stream',
    ...officialClientHeaders(),
  };
  const uid = auth?.account?.uid ?? auth?.uid ?? jwtSub(auth.accessToken);
  if (uid) headers['X-User-Id'] = encodeURIComponent(String(uid));
  if (process.env.WB_DEBUG) {
    fs.writeFileSync(path.join(AUTH_DIR, 'last-request.json'), JSON.stringify(upstreamBody, null, 2));
  }
  const res = await resilientRequest(CHAT_URL, { method: 'POST', headers, body: JSON.stringify(upstreamBody) });
  return {
    ok: res.statusCode >= 200 && res.statusCode < 300,
    status: res.statusCode,
    stream: res,
    text: () => readAll(res),
  };
}

// 上游只支持流式; 聚合 SSE 成单个 chat.completion 对象
async function collectChatCompletion(stream) {
  let content = '', reasoning = '', id = '', model = DEFAULT_MODEL, created = Math.floor(Date.now() / 1000), usage = null, finish = 'stop';
  const toolCalls = {};
  for await (const ev of sseEvents(stream)) {
    id = ev.id || id; model = ev.model || model; created = ev.created || created;
    if (ev.usage) usage = ev.usage;
    const ch = ev.choices?.[0];
    if (!ch) continue;
    if (ch.finish_reason) finish = ch.finish_reason;
    const d = ch.delta || {};
    if (d.content) content += d.content;
    if (d.reasoning_content) reasoning += d.reasoning_content;
    for (const tc of d.tool_calls || []) {
      const t = toolCalls[tc.index ?? 0] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
      if (tc.id) t.id += tc.id;
      if (tc.function?.name) t.function.name += tc.function.name;
      if (tc.function?.arguments) t.function.arguments += tc.function.arguments;
    }
  }
  const msg = { role: 'assistant', content };
  if (reasoning) msg.reasoning_content = reasoning;
  const tcs = Object.values(toolCalls).filter(t => t.function.name || t.function.arguments);
  if (tcs.length) msg.tool_calls = tcs;
  return { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: msg, finish_reason: finish }], usage };
}

// 处理 401 刷新重试 + 429 限流退避重试(官方客户端同样会自动重试)
async function withAuthRetry(fn, retried401 = false, retries429 = 0) {
  let auth = loadAuth();
  if (!auth?.accessToken) return { error: [401, { error: { message: 'proxy 未登录, 先运行: node wb-proxy.mjs login' } }] };
  auth = await refreshIfNeeded(auth);
  let up;
  try {
    up = await fn(auth);
  } catch (e) {
    return { error: [502, { error: { message: 'upstream connect failed: ' + e.message } }] };
  }
  if (up.status === 401 && !retried401 && auth.refreshToken) {
    up.stream.destroy();
    auth.expiresAt = 0; saveAuth(auth);
    await refreshIfNeeded(loadAuth());
    return withAuthRetry(fn, true, retries429);
  }
  if (up.status === 429 && retries429 < 3) {
    up.stream.destroy();
    const waitMs = [4000, 10000, 20000][retries429];
    console.log(`[retry] 上游 429, ${waitMs / 1000}s 后第 ${retries429 + 1} 次重试`);
    await new Promise(r => setTimeout(r, waitMs));
    return withAuthRetry(fn, retried401, retries429 + 1);
  }
  return { up };
}

// ---------------- Chat Completions ----------------

async function handleChat(req, res, body) {
  let inBody;
  try { inBody = JSON.parse(body); } catch { return sendJson(res, 400, { error: { message: 'invalid json body' } }); }

  const wantStream = inBody.stream === true;
  // 网关安全策略: 首条消息必须是 system prompt; 不认 developer 角色, 归一成 system
  const messages = (Array.isArray(inBody.messages) ? inBody.messages : [])
    .map(m => m?.role === 'developer' ? { ...m, role: 'system' } : m);
  if (!messages.length || messages[0]?.role !== 'system') {
    messages.unshift({ role: 'system', content: DEFAULT_SYSTEM_PROMPT });
  }
  const upstreamBody = {
    ...inBody,
    messages,
    model: inBody.model && inBody.model !== 'default' ? inBody.model : DEFAULT_MODEL,
    stream: true, // 上游只支持流式
  };

  const { up, error } = await withAuthRetry(auth => callUpstream(auth, upstreamBody));
  if (error) return sendJson(res, error[0], error[1]);
  if (!up.ok) {
    const text = await up.text().catch(() => '');
    return sendJson(res, up.status, { error: { message: `upstream ${up.status}`, detail: text.slice(0, 2000) } });
  }

  if (wantStream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    up.stream.pipe(res);
    up.stream.on('error', () => res.destroy());
    req.on('close', () => up.stream.destroy());
  } else {
    sendJson(res, 200, await collectChatCompletion(up.stream));
  }
}

// ---------------- Responses API (Codex 等新版客户端用) ----------------

// Responses 请求 → Chat Completions 请求 (只透传上游认识的字段)
function responsesToChat(inBody) {
  const messages = [];
  if (inBody.instructions) messages.push({ role: 'system', content: String(inBody.instructions) });
  const input = inBody.input;
  if (typeof input === 'string') {
    messages.push({ role: 'user', content: input });
  } else if (Array.isArray(input)) {
    let pendingCalls = null; // 连续的 function_call 合并成一条 assistant 消息 (OpenAI 并行工具调用格式)
    const flushCalls = () => {
      if (pendingCalls?.length) messages.push({ role: 'assistant', content: '', tool_calls: pendingCalls });
      pendingCalls = null;
    };
    for (const item of input) {
      if (!item) continue;
      const t = item.type;
      if (t === 'message' || (!t && item.role)) {
        flushCalls();
        // WorkBuddy 网关不认 developer 角色, 归一成 system
        const role = (item.role === 'developer') ? 'system' : (item.role || 'user');
        let parts = item.content;
        if (typeof parts === 'string') { messages.push({ role, content: parts }); continue; }
        if (!Array.isArray(parts)) continue;
        const mapped = [];
        for (const p of parts) {
          if (!p) continue;
          if (p.type === 'input_text' || p.type === 'output_text' || p.type === 'text') mapped.push({ type: 'text', text: p.text ?? '' });
          else if (p.type === 'input_image' && p.image_url) mapped.push({ type: 'image_url', image_url: { url: p.image_url } });
          else if (p.type === 'image_url') mapped.push(p);
        }
        if (!mapped.length) continue;
        messages.push({ role, content: mapped.length === 1 && mapped[0].type === 'text' ? mapped[0].text : mapped });
      } else if (t === 'function_call') {
        (pendingCalls ??= []).push({ id: item.call_id || item.id, type: 'function', function: { name: item.name, arguments: item.arguments ?? '' } });
        continue;
      } else if (t === 'function_call_output') {
        flushCalls();
        messages.push({ role: 'tool', tool_call_id: item.call_id, content: typeof item.output === 'string' ? item.output : JSON.stringify(item.output) });
      } else {
        flushCalls();
      }
      // reasoning / item_reference 等直接忽略
    }
    flushCalls();
  }
  const chat = { model: inBody.model || DEFAULT_MODEL, messages, stream: true };
  if (typeof inBody.temperature === 'number') chat.temperature = inBody.temperature;
  if (typeof inBody.top_p === 'number') chat.top_p = inBody.top_p;
  if (typeof inBody.max_output_tokens === 'number') chat.max_tokens = inBody.max_output_tokens;
  if (typeof inBody.parallel_tool_calls === 'boolean') chat.parallel_tool_calls = inBody.parallel_tool_calls;
  if (inBody.stop) chat.stop = inBody.stop;
  if (Array.isArray(inBody.tools)) {
    const tools = inBody.tools.filter(t => t?.type === 'function')
      .map(t => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (tools.length) chat.tools = tools;
  }
  if (typeof inBody.tool_choice === 'string') chat.tool_choice = inBody.tool_choice;
  else if (inBody.tool_choice?.type === 'function' && inBody.tool_choice.name) chat.tool_choice = { type: 'function', function: { name: inBody.tool_choice.name } };
  const fmt = inBody.text?.format;
  if (fmt?.type === 'json_object') chat.response_format = { type: 'json_object' };
  else if (fmt?.type === 'json_schema') chat.response_format = { type: 'json_schema', json_schema: { name: fmt.name, schema: fmt.schema, strict: fmt.strict } };
  return chat;
}

function mapUsage(u) {
  if (!u) return null;
  return {
    input_tokens: u.prompt_tokens ?? 0,
    input_tokens_details: { cached_tokens: u.prompt_tokens_details?.cached_tokens ?? 0 },
    output_tokens: u.completion_tokens ?? 0,
    output_tokens_details: { reasoning_tokens: u.completion_tokens_details?.reasoning_tokens ?? 0 },
    total_tokens: u.total_tokens ?? 0,
  };
}

// chat.completion 对象 → Responses 响应对象
function chatToResponseObject(cc, status = 'completed') {
  const output = [];
  const msg = cc.choices?.[0]?.message || {};
  if (msg.reasoning_content) {
    output.push({ id: 'rs_' + cc.id, type: 'reasoning', summary: [{ type: 'summary_text', text: msg.reasoning_content }] });
  }
  if (msg.content) {
    output.push({ id: 'msg_' + cc.id, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: msg.content, annotations: [] }] });
  }
  for (const tc of msg.tool_calls || []) {
    output.push({ id: 'fc_' + (tc.id || cc.id), type: 'function_call', status: 'completed', call_id: tc.id, name: tc.function?.name || '', arguments: tc.function?.arguments || '' });
  }
  return {
    id: 'resp_' + cc.id, object: 'response', created_at: cc.created, status,
    model: cc.model, output, parallel_tool_calls: true,
    usage: mapUsage(cc.usage),
  };
}

// 把上游 chat SSE 实时翻译成 Responses SSE 事件流
async function streamChatAsResponses(upStream, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  let seq = 0;
  const respId = 'resp_' + Math.random().toString(36).slice(2);
  const created = Math.floor(Date.now() / 1000);
  let model = DEFAULT_MODEL, usage = null;
  const items = [];           // 已完成的 output items
  let cur = null;             // 当前打开的 item: {kind:'reasoning'|'message'|'function_call', ...}
  const send = (type, data) => res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
  const respObj = (status) => ({ id: respId, object: 'response', created_at: created, status, model, output: items, parallel_tool_calls: true, usage: mapUsage(usage) });
  const closeCur = () => {
    if (!cur) return;
    if (cur.kind === 'reasoning') {
      send('response.reasoning_summary_text.done', { item_id: cur.id, output_index: cur.index, summary_index: 0, text: cur.text });
      send('response.reasoning_summary_part.done', { item_id: cur.id, output_index: cur.index, summary_index: 0, part: { type: 'summary_text', text: cur.text } });
      send('response.output_item.done', { output_index: cur.index, item: { id: cur.id, type: 'reasoning', summary: [{ type: 'summary_text', text: cur.text }] } });
      items.push({ id: cur.id, type: 'reasoning', summary: [{ type: 'summary_text', text: cur.text }] });
    } else if (cur.kind === 'message') {
      send('response.output_text.done', { item_id: cur.id, output_index: cur.index, content_index: 0, text: cur.text });
      send('response.content_part.done', { item_id: cur.id, output_index: cur.index, content_index: 0, part: { type: 'output_text', text: cur.text, annotations: [] } });
      const item = { id: cur.id, type: 'message', status: 'completed', role: 'assistant', content: [{ type: 'output_text', text: cur.text, annotations: [] }] };
      send('response.output_item.done', { output_index: cur.index, item });
      items.push(item);
    } else if (cur.kind === 'function_call') {
      send('response.function_call_arguments.done', { item_id: cur.id, output_index: cur.index, arguments: cur.args });
      const item = { id: cur.id, type: 'function_call', status: 'completed', call_id: cur.callId, name: cur.name, arguments: cur.args };
      send('response.output_item.done', { output_index: cur.index, item });
      items.push(item);
    }
    cur = null;
  };
  const openReasoning = () => {
    closeCur();
    cur = { kind: 'reasoning', id: 'rs_' + respId + '_' + items.length, index: items.length, text: '' };
    send('response.output_item.added', { output_index: cur.index, item: { id: cur.id, type: 'reasoning', summary: [] } });
    send('response.reasoning_summary_part.added', { item_id: cur.id, output_index: cur.index, summary_index: 0, part: { type: 'summary_text', text: '' } });
  };
  const openMessage = () => {
    closeCur();
    cur = { kind: 'message', id: 'msg_' + respId + '_' + items.length, index: items.length, text: '' };
    send('response.output_item.added', { output_index: cur.index, item: { id: cur.id, type: 'message', status: 'in_progress', role: 'assistant', content: [] } });
    send('response.content_part.added', { item_id: cur.id, output_index: cur.index, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } });
  };
  const openFunctionCall = (tc) => {
    closeCur();
    cur = { kind: 'function_call', id: 'fc_' + (tc.id || respId + '_' + items.length), index: items.length, callId: tc.id || '', name: '', args: '' };
    send('response.output_item.added', { output_index: cur.index, item: { id: cur.id, type: 'function_call', status: 'in_progress', call_id: cur.callId, name: '', arguments: '' } });
  };

  send('response.created', { response: respObj('in_progress') });
  send('response.in_progress', { response: respObj('in_progress') });

  for await (const ev of sseEvents(upStream)) {
    model = ev.model || model;
    if (ev.usage) usage = ev.usage;
    const d = ev.choices?.[0]?.delta || {};
    if (d.reasoning_content) {
      if (cur?.kind !== 'reasoning') openReasoning();
      cur.text += d.reasoning_content;
      send('response.reasoning_summary_text.delta', { item_id: cur.id, output_index: cur.index, summary_index: 0, delta: d.reasoning_content });
    }
    if (d.content) {
      if (cur?.kind !== 'message') openMessage();
      cur.text += d.content;
      send('response.output_text.delta', { item_id: cur.id, output_index: cur.index, content_index: 0, delta: d.content });
    }
    for (const tc of d.tool_calls || []) {
      const isNew = cur?.kind !== 'function_call' || (tc.id && cur.callId && tc.id !== cur.callId);
      if (isNew) openFunctionCall(tc);
      if (tc.id) cur.callId = tc.id;
      if (tc.function?.name) cur.name += tc.function.name;
      const a = tc.function?.arguments || '';
      if (a) {
        cur.args += a;
        send('response.function_call_arguments.delta', { item_id: cur.id, output_index: cur.index, delta: a });
      }
    }
  }
  closeCur();
  send('response.completed', { response: respObj('completed') });
  res.end();
}

async function handleResponses(req, res, body) {
  let inBody;
  try { inBody = JSON.parse(body); } catch { return sendJson(res, 400, { error: { message: 'invalid json body' } }); }
  const wantStream = inBody.stream === true;
  const chatBody = responsesToChat(inBody);
  if (!chatBody.messages.length || chatBody.messages[0]?.role !== 'system') {
    chatBody.messages.unshift({ role: 'system', content: DEFAULT_SYSTEM_PROMPT });
  }

  const { up, error } = await withAuthRetry(auth => callUpstream(auth, chatBody));
  if (error) return sendJson(res, error[0], error[1]);
  if (!up.ok) {
    const text = await up.text().catch(() => '');
    return sendJson(res, up.status, { error: { message: `upstream ${up.status}`, detail: text.slice(0, 2000) } });
  }

  if (wantStream) {
    req.on('close', () => up.stream.destroy());
    await streamChatAsResponses(up.stream, res);
  } else {
    sendJson(res, 200, chatToResponseObject(await collectChatCompletion(up.stream)));
  }
}

// ---------------- serve ----------------

function serve(port, localKey, host = '127.0.0.1') {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (localKey) {
      const k = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      if (k !== localKey) return sendJson(res, 401, { error: { message: 'invalid local api key' } });
    }
    if (req.method === 'GET' && (url.pathname === '/v1/models' || url.pathname === '/models')) {
      return sendJson(res, 200, { object: 'list', data: [
        ...FREE_MODELS.map(id => ({ id, object: 'model', owned_by: 'workbuddy', free: true })),
        ...PAID_MODELS.map(id => ({ id, object: 'model', owned_by: 'workbuddy', free: false })),
      ] });
    }
    if (req.method === 'POST' && (url.pathname === '/v1/chat/completions' || url.pathname === '/chat/completions')) {
      return handleChat(req, res, await readAll(req));
    }
    if (req.method === 'POST' && (url.pathname === '/v1/responses' || url.pathname === '/responses')) {
      return handleResponses(req, res, await readAll(req));
    }
    if (req.method === 'GET' && url.pathname === '/health') return sendJson(res, 200, { ok: true, authed: !!loadAuth()?.accessToken });
    sendJson(res, 404, { error: { message: 'not found' } });
  });
  server.listen(port, host, () => {
    console.log(`wb-proxy 已启动: http://${host}:${port}/v1  (model: ${DEFAULT_MODEL})`);
    console.log('端点: /v1/chat/completions (OpenAI)  +  /v1/responses (Codex)');
  });
}

// ---------------- main ----------------

const [, , cmd, ...rest] = process.argv;
if (cmd === 'login') {
  login();
} else if (cmd === 'serve') {
  const port = Number(rest[rest.indexOf('--port') + 1]) || 8377;
  const ki = rest.indexOf('--key');
  const hi = rest.indexOf('--host');
  const host = hi >= 0 ? rest[hi + 1] : '127.0.0.1';
  if (host !== '127.0.0.1' && host !== '::1' && ki < 0) {
    console.error('监听非本机地址时必须加 --key 保护接口, 否则任何人都能用你的额度');
    process.exit(1);
  }
  serve(port, ki >= 0 ? rest[ki + 1] : null, host);
} else {
  console.log('用法: node wb-proxy.mjs login | serve [--port 8377] [--host 0.0.0.0] [--key xxx]');
}
