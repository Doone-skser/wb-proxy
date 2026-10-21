#!/usr/bin/env node
// mux — 单端口路径分发: /qoder/* → qoder-proxy, 其余 → wb-proxy
// 零依赖,流式(SSE)透传。Node.js >= 18
import http from 'node:http';

const PORT = parseInt(process.env.MUX_PORT || '18777', 10);
const HOST = process.env.MUX_HOST || '0.0.0.0';
const ROUTES = [
  { prefix: '/qoder/', target: { host: '127.0.0.1', port: 18778 }, strip: '/qoder' },
];
const FALLBACK = { host: '127.0.0.1', port: 18779 };

const server = http.createServer((req, res) => {
  const url = req.url || '/';
  const route = ROUTES.find(r => url.startsWith(r.prefix));
  const target = route ? route.target : FALLBACK;
  const path = route ? (url.slice(route.strip.length) || '/') : url;

  const proxyReq = http.request(
    { host: target.host, port: target.port, path, method: req.method, headers: req.headers },
    proxyRes => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', e => {
    console.error(`[mux] ${target.port}${path} -> ${e.message}`);
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'backend unreachable: ' + e.message, type: 'mux_error' } }));
    } else res.end();
  });
  req.pipe(proxyReq);
});

server.listen(PORT, HOST, () => {
  console.log(`mux listening on http://${HOST}:${PORT}  /qoder/* -> ${ROUTES[0].target.port}  * -> ${FALLBACK.port}`);
});
