// 服务器冒烟测试：node test/smoke.test.js（需要 Node.js 22+ 自带的 WebSocket 客户端）
import { spawn } from 'node:child_process';
import net from 'node:net';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { decodeSnapshot } from '../public/protocol.js';

if (typeof WebSocket === 'undefined') {
  console.log('跳过：需要 Node.js 22+（自带 WebSocket 客户端）');
  process.exit(0);
}

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const srv = spawn(process.execPath, ['server.js'], { cwd: root, env: { ...process.env, PORT: '0', MIN_CARS: '0' } });
let out = '';
const port = await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('服务器没启动：' + out)), 8000);
  srv.stdout.on('data', (d) => {
    out += d;
    const m = /listening on port (\d+)/.exec(out);
    if (m) { clearTimeout(t); resolve(Number(m[1])); }
  });
  srv.stderr.on('data', (d) => (out += d));
});
const base = `http://127.0.0.1:${port}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function test(name, fn) {
  await fn();
  passed++;
  console.log('  ✓ ' + name);
}

function rawGet(p) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1', () => s.write(`GET ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n`));
    let buf = '';
    s.on('data', (d) => (buf += d));
    s.on('close', () => resolve(buf));
    s.on('error', () => resolve(buf));
  });
}

function join({ name = '', locale = 'en', prediction = false } = {}) {
  return new Promise((resolve, reject) => {
    const params = new URLSearchParams({ country: 'CN', name, locale });
    if (prediction) params.set('v', '2');
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?${params}`);
    ws.binaryType = 'arraybuffer';
    const c = { ws, json: [], snaps: [], welcome: null, roster: null };
    ws.onmessage = (e) => {
      if (typeof e.data === 'string') {
        const m = JSON.parse(e.data);
        c.json.push(m);
        if (m.t === 'welcome') { c.welcome = m; resolve(c); }
        if (m.t === 'roster') c.roster = m.list;
      } else c.snaps.push(decodeSnapshot(e.data));
    };
    ws.onerror = reject;
  });
}

try {
  console.log('服务器：');
  await test('首页可以打开，并带安全头', async () => {
    const r = await fetch(base + '/');
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
    const html = await r.text();
    assert.match(html, /World Clash/);
    const version = await (await fetch(base + '/version')).json();
    assert.match(version.build, /^[a-f0-9]{10}$/);
    assert.equal(r.headers.get('x-worldclash-build'), version.build);
    assert.ok(html.includes(`game.js?build=${version.build}`), '页面必须固定实际加载的客户端版本');
    assert.ok(!html.includes('__BUILD__'));
    const head = await fetch(base + '/', { method: 'HEAD' });
    assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(html));
    const js = await fetch(base + '/game.js');
    assert.equal(js.status, 200);
    assert.match(js.headers.get('content-type'), /javascript/);
    const flag = await fetch(base + '/flags/CN.svg');
    assert.equal(flag.status, 200);
    assert.match(flag.headers.get('content-type'), /image\/svg/);
    assert.match(await flag.text(), /<svg/);
    assert.equal((await fetch(base + '/flags/XX.svg')).status, 404);
  });

  await test('不能读到网页目录以外的文件', async () => {
    for (const p of ['/../server.js', '/..%2fserver.js', '/%2e%2e/%2e%2e/etc/passwd', '/vendor/../../src/sim.js']) {
      const res = await rawGet(p);
      assert.ok(!/200 OK/.test(res.split('\r\n')[0]) || !/WORLD|import/.test(res), `路径 ${p} 不应返回源码`);
    }
  });

  await test('打开网页就自动加入，并分到一辆车', async () => {
    const a = await join();
    const b = await join();
    await sleep(400);
    assert.ok(a.welcome.id && b.welcome.id && a.welcome.id !== b.welcome.id);
    assert.equal(a.roster.length, 2);
    assert.equal(a.roster.find((r) => r[0] === b.welcome.id)[4], 'CN');
    const last = a.snaps.at(-1);
    assert.ok(last.cars.has(a.welcome.id) && last.cars.has(b.welcome.id));
    assert.ok(a.snaps.length >= 8, `0.4 秒内应收到约 12 帧快照，实际 ${a.snaps.length}`);
    a.ws.close();
    b.ws.close();
    await sleep(200);
  });

  await test('同时加入的同名玩家自动编号，所有玩家看到一致昵称', async () => {
    const players = await Promise.all(Array.from({ length: 3 }, () => join({ name: '小车', locale: 'zh-CN' })));
    try {
      await sleep(200);
      assert.deepEqual(players.map((p) => p.welcome.name).sort(), ['小车', '小车1', '小车2']);
      for (const player of players) {
        for (const other of players) {
          assert.equal(player.roster.find((row) => row[0] === other.welcome.id)[1], other.welcome.name);
        }
      }
    } finally {
      players.forEach((p) => p.ws.close());
      await sleep(200);
    }
  });

  await test('预测连接收到精确自身状态，服务器确认输入且拒绝非法驾驶包', async () => {
    const c = await join({ prediction: true });
    try {
      await sleep(100);
      assert.equal(c.welcome.prediction, true);
      const before = c.snaps.at(-1).self;
      assert.ok(before.epoch > 0);
      assert.ok(c.snaps.at(-1).tick > 0);
      c.ws.send(JSON.stringify({ t: 'inputs', epoch: before.epoch, from: 1, frames: Array(6).fill([1, 0]) }));
      await sleep(200);
      const confirmed = c.snaps.at(-1);
      assert.equal(confirmed.ack, 6);
      assert.ok(Math.hypot(confirmed.self.vx, confirmed.self.vz) > 0);
      c.ws.send(JSON.stringify({ t: 'inputs', epoch: before.epoch, from: 1, frames: Array(6).fill([1, 0]) }));
      await sleep(100);
      assert.equal(c.snaps.at(-1).ack, 6, '重发已确认的操作不得重复模拟');
      const closed = new Promise((resolve) => c.ws.addEventListener('close', resolve, { once: true }));
      c.ws.send(JSON.stringify({ t: 'inputs', epoch: before.epoch, from: 7, frames: [[999, 0]] }));
      assert.equal((await closed).code, 1008);
    } finally {
      c.ws.close();
    }
  });

  await test('按油门车会动，掉下楼会收到结算并自动重来', async () => {
    const c = await join({ prediction: true });
    const id = c.welcome.id;
    await sleep(2700); // 等出生保护结束
    const start = c.snaps.at(-1).cars.get(id);
    const world = c.welcome.world;
    const angleDiff = (a) => Math.atan2(Math.sin(a), Math.cos(a));
    const routes = Array.from({ length: 64 }, (_, i) => {
      const h = start.h + i * Math.PI / 32;
      const dx = Math.sin(h), dz = Math.cos(h);
      const tx = Math.abs(dx) < 1e-6 ? Infinity : ((dx > 0 ? world.hw : -world.hw) - start.x) / dx;
      const tz = Math.abs(dz) < 1e-6 ? Infinity : ((dz > 0 ? world.hd : -world.hd) - start.z) / dz;
      const distance = Math.min(tx, tz) + 4;
      const clear = world.obstacles.every((ob) => {
        const along = Math.max(0, Math.min(distance, (ob.x - start.x) * dx + (ob.z - start.z) * dz));
        const radius = ob.type === 'cyl' ? ob.r : Math.hypot(ob.w, ob.d) / 2;
        return Math.hypot(start.x + dx * along - ob.x, start.z + dz * along - ob.z) > radius + 1.8;
      });
      return { x: start.x + dx * distance, z: start.z + dz * distance, clear,
        cost: Math.abs(angleDiff(h - start.h)) * 12 + distance };
    }).filter((r) => r.clear).sort((a, b) => a.cost - b.cost);
    assert.ok(routes.length, '应能找到避开障碍物的出界路线');
    const target = routes[0];
    let sequence = 0;
    const epoch = c.snaps.at(-1).self.epoch;
    const drive = setInterval(() => {
      const car = c.snaps.at(-1).cars.get(id);
      if (!car || car.falling) return;
      const diff = angleDiff(Math.atan2(target.x - car.x, target.z - car.z) - car.h);
      const st = Math.max(-1, Math.min(1, -diff * 2));
      c.ws.send(JSON.stringify({ t: 'inputs', epoch, from: sequence + 1, frames: Array(3).fill([1, st]) }));
      sequence += 3;
    }, 50);
    let dead = null;
    for (let i = 0; i < 240 && !dead; i++) {
      await sleep(50);
      dead = c.json.find((m) => m.t === 'dead');
    }
    clearInterval(drive);
    assert.ok(dead, '一直往前开应该会冲出楼顶');
    assert.equal(dead.by, 0);
    const fell = c.json.some((m) => m.t === 'ev' && m.e.some((e) => e[0] === 'fall' && e[1] === id));
    assert.ok(fell);
    assert.ok(start, '应该有起始位置');
    await sleep(1200);
    const again = c.snaps.at(-1).cars.get(id);
    assert.ok(again && again.level === 1, '重来后应该有新车');
    const newEpoch = c.snaps.at(-1).self.epoch;
    assert.ok(newEpoch > epoch, '重生必须使用新的生命编号');
    c.ws.send(JSON.stringify({ t: 'inputs', epoch: newEpoch, from: 1, frames: [[0, 0]] }));
    await sleep(100);
    assert.equal(c.snaps.at(-1).ack, 1, '重生后应从新输入序列继续确认');
    c.ws.close();
    await sleep(200);
  });

  await test('乱发数据不会让服务器崩溃', async () => {
    // 1) 握手后发未加掩码的帧 → 应被断开
    await new Promise((resolve) => {
      const s = net.connect(port, '127.0.0.1', () => {
        s.write('GET /ws?country=CN HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
        setTimeout(() => s.write(Buffer.from([0x81, 0x05, 0x68, 0x65, 0x6c, 0x6c, 0x6f])), 100);
      });
      s.on('data', () => {});
      s.on('close', resolve);
      s.on('error', resolve);
      setTimeout(() => { s.destroy(); resolve(); }, 2000);
    });
    // 2) 超大帧、坏 JSON、非法输入值
    const c = await join();
    c.ws.send('x'.repeat(5000));
    await sleep(200);
    const c2 = await join();
    c2.ws.send('{not json');
    c2.ws.send(JSON.stringify({ t: 'in', th: 'NaN', st: 1e9 }));
    c2.ws.send(JSON.stringify({ t: 'in', th: null, st: [1] }));
    c2.ws.send(JSON.stringify(null));
    await sleep(300);
    const car = c2.snaps.at(-1).cars.get(c2.welcome.id);
    assert.ok(Number.isFinite(car.x) && Number.isFinite(car.z));
    const r = await fetch(base + '/healthz');
    assert.equal(await r.text(), 'ok');
    c2.ws.close();
  });

  await test('单机 10 车混战模式连接不产生快照开销，且击落实时同步国家积分排行榜', async () => {
    const a = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?country=CN&name=SoloA&mode=solo`);
      const c = { ws, json: [], snaps: 0, welcome: null };
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          const m = JSON.parse(e.data);
          c.json.push(m);
          if (m.t === 'welcome') { c.welcome = m; resolve(c); }
        } else c.snaps++;
      };
      ws.onerror = reject;
    });
    const b = await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?country=US&name=SoloB&mode=solo`);
      const c = { ws, json: [], snaps: 0, welcome: null };
      ws.onmessage = (e) => {
        if (typeof e.data === 'string') {
          const m = JSON.parse(e.data);
          c.json.push(m);
          if (m.t === 'welcome') { c.welcome = m; resolve(c); }
        } else c.snaps++;
      };
      ws.onerror = reject;
    });
    try {
      assert.equal(a.welcome.solo, true);
      assert.equal(a.welcome.cfg.soloCars, 10);
      a.ws.send(JSON.stringify({ t: 'ko', country: 'CN' }));
      await sleep(200);
      assert.equal(a.snaps, 0, '单机模式不应下发快照包');
      const latestScores = b.json.filter((m) => m.t === 'scores').at(-1);
      assert.ok(latestScores && latestScores.scores.some(([code, score]) => code === 'CN' && score >= 1), '所有客户端应实时收到更新后的国家积分');
    } finally {
      a.ws.close();
      b.ws.close();
      await sleep(100);
    }
  });

  await test('100 名真人可以同时连接，第 101 人会收到满员提示', async () => {
    const players = await Promise.all(Array.from({ length: 100 }, () => join()));
    try {
      await sleep(600);
      assert.equal(new Set(players.map((p) => p.welcome.id)).size, 100);
      assert.ok(players[0].snaps.at(-1).cars.size >= 100);
      const full = new WebSocket(`ws://127.0.0.1:${port}/ws?country=CN`);
      const message = await new Promise((resolve, reject) => {
        full.onmessage = (e) => resolve(JSON.parse(e.data));
        full.onerror = reject;
      });
      assert.equal(message.t, 'full');
      assert.equal(message.max, 100);
      full.close();
    } finally {
      for (const player of players) player.ws.close();
    }
  });

  console.log(`\n全部 ${passed} 项通过 ✅`);
} finally {
  srv.kill('SIGTERM');
}
