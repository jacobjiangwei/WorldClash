#!/usr/bin/env node
// World Clash — 游戏服务器。
// 同一个端口既提供网页（public/），也提供 WebSocket 游戏连接（/ws）。
// 运行：npm ci && node server.js（Node.js 18+）

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { Game, WORLD, TUNING } from './src/sim.js';
import { acceptWebSocket } from './src/ws.js';
import { encodeSnapshot } from './public/protocol.js';
import { countryCodes } from './public/countries.js';
import { Scores, recordKnockout } from './src/scores.js';
import { InputQueue } from './public/netcode.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const FLAGS_DIR = path.join(ROOT, 'node_modules', 'flag-icons', 'flags', '4x3');
const buildHash = createHash('sha256');
for (const file of ['server.js', 'src/ws.js', 'src/scores.js', 'public/index.html', 'public/style.css',
  'public/game.js', 'public/sim.js', 'public/netcode.js', 'public/protocol.js', 'public/countries.js', 'public/promotions.js']) {
  buildHash.update(file).update('\0').update(fs.readFileSync(path.join(ROOT, file)));
}
const BUILD_ID = buildHash.digest('hex').slice(0, 10);
const INSTANCE_ID = randomUUID().slice(0, 8);
const INDEX_FILE = path.join(PUBLIC_DIR, 'index.html');
const INDEX_HTML = fs.readFileSync(INDEX_FILE, 'utf8').replace('__BUILD__', BUILD_ID);

function envNumber(name, fallback) {
  const v = process.env[name];
  if (v === undefined || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

const PORT = envNumber('PORT', 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_PLAYERS = envNumber('MAX_PLAYERS', 100); // 真人上限
const MIN_CARS = envNumber('MIN_CARS', 10); // 默认 10 车混战；0 = 关闭机器人
const MAX_PER_IP = envNumber('MAX_PER_IP', 0); // 每个 IP 最多几个连接；0 = 不限（放在反向代理后面时保持 0）

const TICK_RATE = 60; // 物理每秒 60 步
const SNAP_EVERY = 2; // 每 2 步广播一次 → 每秒 30 次
const DT = 1 / TICK_RATE;

const game = new Game({ minCars: MIN_CARS });
const scores = new Scores(path.join(process.env.DATA_DIR || path.join(ROOT, 'data'), 'scores.json'));
const clients = new Map(); // 玩家 id -> { ws, id, ip, tokens, refillAt, strikes }
const perIp = new Map();
let sentRosterVersion = -1;

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------------------
// 静态网页
// ---------------------------------------------------------------------------
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};
const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "connect-src 'self' ws: wss:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

function sendText(res, status, text, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'X-Content-Type-Options': 'nosniff', ...extra });
  res.end(text);
}

function handleHttp(req, res) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return sendText(res, 400, 'Bad request');
  }
  if (pathname === '/healthz') return sendText(res, 200, 'ok', { 'X-WorldClash-Build': BUILD_ID });
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendText(res, 405, 'Method not allowed', { Allow: 'GET, HEAD' });
  if (pathname === '/version') {
    const body = JSON.stringify({ build: BUILD_ID, instance: INSTANCE_ID, tick: game.tick, protocol: 2 });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    return res.end(req.method === 'HEAD' ? undefined : body);
  }
  if (pathname.includes('\0') || /(^|\/)\./.test(pathname)) return sendText(res, 404, 'Not found');
  if (pathname.endsWith('/')) pathname += 'index.html';

  let file;
  const flag = /^\/flags\/([A-Z]{2})\.svg$/.exec(pathname);
  if (flag && countryCodes.has(flag[1])) {
    file = path.join(FLAGS_DIR, `${flag[1].toLowerCase()}.svg`);
  } else {
    file = path.resolve(PUBLIC_DIR, '.' + pathname);
    if (!file.startsWith(PUBLIC_DIR + path.sep)) return sendText(res, 403, 'Forbidden');
  }

  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return sendText(res, 404, 'Not found');
    const ext = path.extname(file).toLowerCase();
    const headers = {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Content-Length': st.size,
      'X-WorldClash-Build': BUILD_ID,
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Cache-Control': flag || file.includes(`${path.sep}vendor${path.sep}`) ? 'public, max-age=604800' : 'no-cache',
    };
    if (ext === '.html') headers['Content-Security-Policy'] = CSP;
    if (file === INDEX_FILE) {
      headers['Content-Length'] = Buffer.byteLength(INDEX_HTML);
      res.writeHead(200, headers);
      return res.end(req.method === 'HEAD' ? undefined : INDEX_HTML);
    }
    res.writeHead(200, headers);
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

// ---------------------------------------------------------------------------
// WebSocket：打开网页 = 自动加入游戏，自动分到一辆车
// ---------------------------------------------------------------------------
function clientIp(req) {
  return req.socket.remoteAddress || 'unknown';
}

function handleUpgrade(req, socket, head) {
  socket.on('error', () => {});
  let pathname = '';
  let country = '';
  let name = '';
  let locale = '';
  let prediction = false;
  let solo = false;
  try {
    const url = new URL(req.url, 'http://localhost');
    pathname = url.pathname;
    country = url.searchParams.get('country');
    name = url.searchParams.get('name');
    locale = url.searchParams.get('locale');
    prediction = url.searchParams.get('v') === '2';
    solo = url.searchParams.get('mode') === 'solo';
  } catch {
    /* ignore */
  }
  if (pathname !== '/ws') {
    socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  if (!countryCodes.has(country)) {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const ip = clientIp(req);
  if (MAX_PER_IP > 0 && (perIp.get(ip) || 0) >= MAX_PER_IP) {
    socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    return;
  }
  const ws = acceptWebSocket(req, socket, head, { maxPayload: 2048 });
  if (ws) onConnect(ws, ip, country, name, locale, prediction, solo);
}

let nextSoloId = 100000;
function onConnect(ws, ip, country, name, locale, prediction, solo = false) {
  if (!solo && game.humanCount() >= MAX_PLAYERS) {
    ws.send(JSON.stringify({ t: 'full', max: MAX_PLAYERS }));
    ws.close(1013, 'server full');
    return;
  }
  perIp.set(ip, (perIp.get(ip) || 0) + 1);
  if (solo) {
    const id = ++nextSoloId;
    const client = {
      ws, id, ip, country, solo: true,
      tokens: 90, refillAt: Date.now(), strikes: 0, lastKoAt: 0,
    };
    clients.set(id, client);
    ws.send(JSON.stringify({
      t: 'welcome',
      id,
      name: name || '',
      country,
      solo: true,
      build: BUILD_ID,
      instance: INSTANCE_ID,
      world: WORLD,
      cfg: {
        maxLevel: TUNING.maxLevel,
        massPerLevel: TUNING.massPerLevel,
        scalePerLevel: TUNING.scalePerLevel,
        speedLossPerLevel: TUNING.speedLossPerLevel,
        minCars: MIN_CARS,
        soloCars: 10,
      },
    }));
    ws.send(JSON.stringify(scores.snapshot()));
    ws.on('message', (data, isBinary) => onMessage(client, data, isBinary));
    ws.on('close', () => {
      clients.delete(id);
      const n = (perIp.get(ip) || 1) - 1;
      if (n > 0) perIp.set(ip, n);
      else perIp.delete(ip);
    });
    return;
  }
  const player = game.addPlayer({ name, locale });
  player.country = country;
  game.spawn(player.id);
  const client = { ws, id: player.id, ip, country, solo: false, tokens: 60, refillAt: Date.now(), strikes: 0,
    prediction, inputs: new InputQueue(), epoch: game.cars.get(player.id).epoch, lastKoAt: 0 };
  clients.set(player.id, client);

  ws.send(
    JSON.stringify({
      t: 'welcome',
      id: player.id,
      name: player.name,
      color: player.color,
      country,
      prediction,
      build: BUILD_ID,
      instance: INSTANCE_ID,
      world: WORLD,
      cfg: {
        maxLevel: TUNING.maxLevel,
        massPerLevel: TUNING.massPerLevel,
        scalePerLevel: TUNING.scalePerLevel,
        speedLossPerLevel: TUNING.speedLossPerLevel,
        snapRate: TICK_RATE / SNAP_EVERY,
      },
    }),
  );
  ws.send(JSON.stringify(scores.snapshot()));

  ws.on('message', (data, isBinary) => onMessage(client, data, isBinary));
  ws.on('close', () => {
    clients.delete(player.id);
    game.removePlayer(player.id);
    const n = (perIp.get(ip) || 1) - 1;
    if (n > 0) perIp.set(ip, n);
    else perIp.delete(ip);
    log(`- 玩家 #${player.id} 离开，在线 ${clients.size} 人`);
  });
  log(`+ 玩家 #${player.id}「${player.name}」加入，在线 ${clients.size} 人`);
}

function onMessage(c, data, isBinary) {
  // 简单限流：每秒最多约 75 条消息，持续刷屏就断开
  const now = Date.now();
  c.tokens = Math.min(90, c.tokens + (now - c.refillAt) * 0.075);
  c.refillAt = now;
  if (c.tokens < 1) {
    if (++c.strikes > 300) c.ws.terminate();
    return;
  }
  c.tokens -= 1;
  if (isBinary || data.length > 512) return;

  let m;
  try {
    m = JSON.parse(data);
  } catch {
    return;
  }
  if (!m || typeof m !== 'object') return;
  switch (m.t) {
    case 'ko': {
      const code = typeof m.country === 'string' && countryCodes.has(m.country) ? m.country : c.country;
      if (!countryCodes.has(code)) break;
      if (now - (c.lastKoAt || 0) < 120) break;
      c.lastKoAt = now;
      try {
        scores.add(code);
        sendAll(JSON.stringify(scores.snapshot()));
      } catch (err) {
        console.error('国家积分保存失败:', err);
        c.ws.send(JSON.stringify({ t: 'scoreError' }));
      }
      break;
    }
    case 'in':
      if (!c.solo && !c.prediction) game.setInput(c.id, m.th, m.st);
      break;
    case 'inputs': {
      if (c.solo || !c.prediction) break;
      const car = game.cars.get(c.id);
      if (!car || m.epoch !== car.epoch) break;
      if (c.epoch !== car.epoch) {
        c.inputs.reset();
        c.epoch = car.epoch;
      }
      if (!c.inputs.receive(m.from, m.frames)) {
        c.ws.close(1008, 'invalid input sequence');
        break;
      }
      if (m.sync) c.inputs.applySync(game, c.id, m.sync);
      break;
    }
    case 'release':
      if (c.solo) break;
      c.inputs.release();
      game.setInput(c.id, 0, 0);
      break;
    case 'respawn':
      if (c.solo) break;
      if (typeof m.name === 'string') game.rename(c.id, m.name);
      game.requestSpawn(c.id);
      break;
    case 'name':
      if (c.solo) break;
      if (typeof m.name === 'string') game.rename(c.id, m.name);
      break;
    case 'ping':
      if (typeof m.c === 'number' && Number.isFinite(m.c)) c.ws.send(JSON.stringify({ t: 'pong', c: m.c }));
      break;
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// 游戏主循环：固定 60 步/秒的物理，每秒广播 30 次
// ---------------------------------------------------------------------------
function sendAll(msg) {
  for (const c of clients.values()) c.ws.send(msg);
}

function sendArena(msg) {
  for (const c of clients.values()) {
    if (!c.solo) c.ws.send(msg);
  }
}

function broadcast() {
  let hasArenaClient = false;
  for (const c of clients.values()) {
    if (!c.solo) {
      hasArenaClient = true;
      break;
    }
  }
  if (!hasArenaClient) {
    game.events.length = 0;
    game.deaths.length = 0;
    return;
  }
  if (game.rosterVersion !== sentRosterVersion) {
    sentRosterVersion = game.rosterVersion;
    const list = [...game.players.values()].map((p) => [p.id, p.name, p.color, p.isBot ? 1 : 0, p.country || null]);
    sendArena(JSON.stringify({ t: 'roster', list }));
  }
  if (game.events.length) {
    let scoresChanged = false;
    for (const event of game.events) {
      try {
        if (recordKnockout(scores, game.players, event)) scoresChanged = true;
      } catch (err) {
        console.error('国家积分保存失败:', err);
        sendAll(JSON.stringify({ t: 'scoreError' }));
      }
    }
    if (scoresChanged) sendAll(JSON.stringify(scores.snapshot()));
    sendArena(JSON.stringify({ t: 'ev', e: game.events }));
    game.events = [];
  }
  for (const d of game.deaths) {
    const c = clients.get(d.id);
    if (c && !c.solo) c.ws.send(JSON.stringify({ t: 'dead', ...d }));
  }
  game.deaths.length = 0;

  const cars = [...game.cars.values()];
  const snap = Buffer.from(encodeSnapshot(game.time, cars));
  for (const c of clients.values()) {
    if (c.solo) continue;
    // Drop stale snapshots instead of queuing seconds of latency on a slow link.
    if (c.ws.bufferedAmount < 16 * 1024) {
      const liveSelf = game.cars.get(c.id);
      const self = liveSelf && liveSelf.state === 'alive' && c.inputs.confirmed ? c.inputs.confirmed : liveSelf;
      c.ws.send(c.prediction
        ? encodeSnapshot(game.time, cars, { self, ack: c.inputs.ack, tick: game.tick })
        : snap);
    }
  }
}

let acc = 0;
let last = performance.now();
let steps = 0;
setInterval(() => {
  const now = performance.now();
  acc += Math.min(0.25, (now - last) / 1000);
  last = now;
  while (acc >= DT) {
    acc -= DT;
    for (const c of clients.values()) {
      if (c.solo || !c.prediction) continue;
      const car = game.cars.get(c.id);
      if (car && c.epoch !== car.epoch) {
        c.inputs.reset();
        c.epoch = car.epoch;
      }
      c.inputs.beforeStep(game, c.id, DT);
    }
    game.step(DT);
    for (const c of clients.values()) {
      if (!c.solo && c.prediction) c.inputs.afterStep(game.cars.get(c.id));
    }
    if (++steps % SNAP_EVERY === 0) broadcast();
  }
}, 5);

setInterval(() => {
  if (scores.refresh()) sendAll(JSON.stringify(scores.snapshot()));
}, 1000).unref();

// 心跳：30 秒没有任何数据就断开
setInterval(() => {
  const now = Date.now();
  for (const c of clients.values()) {
    if (now - c.ws.lastSeen > 30000) c.ws.terminate();
    else c.ws.ping();
  }
}, 10000).unref();

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------
const server = http.createServer(handleHttp);
server.on('upgrade', handleUpgrade);
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') console.error(`端口 ${PORT} 已被占用。换个端口试试，例如：PORT=3001 node server.js`);
  else console.error(err);
  process.exit(1);
});
server.listen(PORT, HOST, () => {
  const port = server.address().port;
  console.log('\n🌍🚗💨 World Clash 服务器已启动');
  console.log(`   本机打开:     http://localhost:${port}`);
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) console.log(`   同一网络的朋友: http://${a.address}:${port}`);
    }
  }
  console.log(`   机器人补位: ${MIN_CARS > 0 ? `真人不足 ${MIN_CARS} 人时自动补` : '关闭'} · 真人上限 ${MAX_PLAYERS}`);
  console.log(`listening on port ${port}\n`);
});

function shutdown() {
  for (const c of clients.values()) c.ws.close(1001, 'server shutting down');
  server.close();
  setTimeout(() => process.exit(0), 200).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
