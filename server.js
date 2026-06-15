// Interhuman Signals — Realtime Camera proxy
//
// Architecture:
//   Browser <--ws--> THIS PROXY <--wss--> api.interhuman.ai/v1/stream/analyze
//
// The Interhuman API key NEVER reaches the browser. It is loaded from .env and
// injected by this Node process when opening the upstream WebSocket via the
// `Authorization: Bearer <key>` header (which browsers cannot set on a WS
// handshake — that's why we proxy).

import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const API_KEY = process.env.INTERHUMAN_API_KEY;
const PORT = Number(process.env.PORT || 3737);
const UPSTREAM_URL = 'wss://api.interhuman.ai/v1/stream/analyze';
const PASSCODE = process.env.PASSCODE || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

if (!API_KEY) {
  console.error('[fatal] INTERHUMAN_API_KEY ausente em .env');
  process.exit(1);
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (_req, res) => res.json({
  ok: true,
  upstream: UPSTREAM_URL,
  passcodeRequired: Boolean(PASSCODE),
  originsAllowed: ALLOWED_ORIGINS,
}));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (client, req) => {
  const clientId = Math.random().toString(36).slice(2, 8);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.searchParams.get('p') || '';
  const origin = req.headers.origin || '';

  if (PASSCODE && p !== PASSCODE) {
    log(clientId, 'REJECT passcode', { origin });
    client.close(4401, 'invalid passcode');
    return;
  }
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(origin)) {
    log(clientId, 'REJECT origin', { origin });
    client.close(4403, 'origin not allowed');
    return;
  }

  log(clientId, 'browser conectado', { origin: origin || '(none)' });

  const upstream = new WebSocket(UPSTREAM_URL, {
    headers: { Authorization: `Bearer ${API_KEY}` },
    perMessageDeflate: false,
  });

  let upstreamOpen = false;
  const pendingFromClient = [];

  upstream.on('open', () => {
    upstreamOpen = true;
    log(clientId, 'upstream Interhuman OPEN');
    safeSend(client, JSON.stringify({ type: 'proxy.upstream_open' }));
    for (const msg of pendingFromClient) upstream.send(msg);
    pendingFromClient.length = 0;
  });

  upstream.on('message', (data, isBinary) => {
    if (isBinary) safeSend(client, data, { binary: true });
    else safeSend(client, data.toString(), { binary: false });
  });

  upstream.on('close', (code, reason) => {
    log(clientId, 'upstream CLOSE', code, reason?.toString?.());
    safeSend(client, JSON.stringify({
      type: 'proxy.upstream_close',
      data: { code, reason: reason?.toString?.() || '' },
    }));
    try { client.close(); } catch {}
  });

  upstream.on('error', (err) => {
    log(clientId, 'upstream ERROR', err.message);
    safeSend(client, JSON.stringify({
      type: 'proxy.upstream_error',
      data: { message: err.message },
    }));
  });

  client.on('message', (data, isBinary) => {
    const payload = isBinary ? data : data.toString();
    if (upstreamOpen) upstream.send(payload);
    else pendingFromClient.push(payload);
  });

  client.on('close', (code, reason) => {
    log(clientId, 'browser CLOSE', code, reason?.toString?.());
    try { upstream.close(); } catch {}
  });

  client.on('error', (err) => {
    log(clientId, 'browser ERROR', err.message);
    try { upstream.close(); } catch {}
  });
});

function safeSend(ws, data, opts) {
  if (ws.readyState === WebSocket.OPEN) {
    try { ws.send(data, opts); } catch (e) { console.error('send err', e.message); }
  }
}

function log(id, ...args) {
  console.log(`[${new Date().toISOString()}] [${id}]`, ...args);
}

server.listen(PORT, () => {
  console.log(`\n  Interhuman Signals proxy rodando em :${PORT}`);
  console.log(`  Upstream: ${UPSTREAM_URL}`);
  console.log(`  Chave carregada: ${API_KEY.slice(0, 12)}...${API_KEY.slice(-4)}`);
  console.log(`  Passcode: ${PASSCODE ? 'EXIGIDO' : 'desligado'}`);
  console.log(`  Origins permitidos: ${ALLOWED_ORIGINS.length ? ALLOWED_ORIGINS.join(', ') : '(qualquer)'}\n`);
});
