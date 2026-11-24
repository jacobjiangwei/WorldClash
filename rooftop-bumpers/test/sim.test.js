// 物理与规则测试：node test/sim.test.js
import assert from 'node:assert/strict';
import { Game, WORLD, TUNING, levelStats, drive, collideCars, sanitizeName } from '../src/sim.js';
import { encodeSnapshot, decodeSnapshot } from '../public/protocol.js';

const DT = 1 / 60;
let passed = 0;
function test(name, fn) {
  fn();
  passed++;
  console.log('  ✓ ' + name);
}

// 一个可复现的随机数
function seeded(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bareCar(id, level, x, z, h) {
  const p = levelStats(level);
  return {
    id, x, z, y: 0, vx: 0, vz: 0, h, w: 0, stun: 0, hitBy: 0, hitAt: -99,
    level, p, m: p.mass, I: p.inertia, s: p.scale, protect: 0, state: 'alive', alive: 0, kos: 0, pitch: 0, roll: 0,
  };
}

/** 让车以 speed 前进，然后全力刹车，返回刹车距离 */
function brakingDistance(level, speed) {
  const car = bareCar(1, level, 0, 0, 0);
  car.vz = speed;
  const z0 = car.z;
  for (let i = 0; i < 600 && Math.abs(car.vz) > 0.05; i++) drive(car, { th: -1, st: 0 }, DT);
  return car.z - z0;
}

/** A 车以 speed 侧面撞上静止的 B 车，返回 B 被推开的距离（2.5 秒后） */
function sideHit(levelA, levelB, speed) {
  const a = bareCar(1, levelA, -6, 0, Math.PI / 2); // 朝 +x 开
  const b = bareCar(2, levelB, 0, 0, 0); // 朝 +z 停着，侧面对着 A
  a.vx = speed;
  for (let i = 0; i < 150; i++) {
    drive(a, { th: 1, st: 0 }, DT);
    drive(b, { th: 0, st: 0 }, DT);
    collideCars(a, b, i * DT);
  }
  return b.x;
}

console.log('物理：');
test('1 级车 2 秒内接近最高速', () => {
  const car = bareCar(1, 1, 0, 0, 0);
  for (let i = 0; i < 120; i++) drive(car, { th: 1, st: 0 }, DT);
  assert.ok(car.vz > levelStats(1).maxSpeed * 0.95, `速度 ${car.vz}`);
});

test('越重越难刹车（同样 10 m/s）', () => {
  const d1 = brakingDistance(1, 10);
  const d10 = brakingDistance(10, 10);
  console.log(`      刹车距离：1 级 ${d1.toFixed(2)} m，10 级 ${d10.toFixed(2)} m`);
  assert.ok(d10 > d1 * 1.6);
});

test('重车更难被撞走，但不是撞不动', () => {
  const light = sideHit(1, 1, 14);
  const heavy = sideHit(1, 10, 14);
  console.log(`      1 级车以 14 m/s 侧撞：撞 1 级车推开 ${light.toFixed(1)} m，撞 10 级车推开 ${heavy.toFixed(1)} m`);
  assert.ok(light > heavy);
  assert.ok(heavy > 3, '满级车也应该能被撞动');
});

test('不击落对手，存活再久也不会升级', () => {
  const g = new Game({ minCars: 0, random: seeded(1) });
  const p = g.addPlayer({ name: 'test' });
  const car = g.spawn(p.id);
  car.x = 0; car.z = 0;
  for (let i = 0; i < 41 * 60; i++) {
    g.setInput(p.id, 0, 0);
    g.step(DT);
  }
  assert.equal(g.cars.get(p.id).level, 1);
});

test('开出边缘会掉楼并死亡', () => {
  const g = new Game({ minCars: 0, random: seeded(2) });
  const p = g.addPlayer({ name: 'diver' });
  const car = g.spawn(p.id);
  car.x = WORLD.hw - 4; car.z = 0; car.h = Math.PI / 2; // 朝 +x 边缘
  let fell = false;
  for (let i = 0; i < 6 * 60 && g.players.get(p.id).deadAt < 0; i++) {
    g.setInput(p.id, 1, 0);
    g.step(DT);
    if (g.events.some((e) => e[0] === 'fall' && e[1] === p.id)) fell = true;
  }
  assert.ok(fell, '应该触发掉楼事件');
  assert.equal(g.cars.has(p.id), false);
  assert.equal(g.deaths.length, 1);
  assert.equal(g.deaths[0].by, 0);
});

test('被别人撞下楼会记在对方头上', () => {
  const g = new Game({ minCars: 0, random: seeded(3) });
  const victim = g.addPlayer({ name: 'victim' });
  const bully = g.addPlayer({ name: 'bully' });
  const v = g.spawn(victim.id);
  const b = g.spawn(bully.id);
  v.protect = 0; b.protect = 0;
  v.x = WORLD.hw - 3; v.z = 0; v.h = 0; // 侧面对着边缘
  b.x = WORLD.hw - 14; b.z = 0; b.h = Math.PI / 2; // 从内侧冲过来
  for (let i = 0; i < 5 * 60 && g.cars.has(victim.id); i++) {
    g.setInput(bully.id, 1, 0);
    g.setInput(victim.id, 0, 0);
    g.step(DT);
  }
  const d = g.deaths.find((x) => x.id === victim.id);
  assert.ok(d, 'victim 应该掉下去了');
  assert.equal(d.by, bully.id);
  assert.equal(d.byName, 'bully');
  assert.equal(g.cars.get(bully.id).level, 2);
});

test('只有击落才升级，击落机器人也升级，最高 20 级', () => {
  const g = new Game({ minCars: 0, random: seeded(7) });
  const killer = g.addPlayer({});
  const car = g.spawn(killer.id);
  car.alive = 40;
  for (let i = 0; i < 25; i++) {
    const p = g.addPlayer({ isBot: true });
    const victim = g.spawn(p.id);
    victim.hitBy = killer.id;
    victim.hitAt = g.time;
    g._startFall(victim);
    assert.equal(car.level, Math.min(20, i + 2));
    g.removePlayer(p.id);
  }
  assert.equal(car.level, 20);
  assert.equal(car.kos, 25);
});

test('20 级更重更慢，起步、转向和刹车都更迟钝', () => {
  const light = levelStats(1);
  const medium = levelStats(10);
  const heavy = levelStats(20);
  for (const key of ['maxSpeed', 'accel', 'brake', 'turnRate', 'steerK', 'coast']) {
    assert.ok(light[key] > medium[key] && medium[key] > heavy[key], `${key} 随等级降低`);
  }
  assert.ok(light.mass < medium.mass && medium.mass < heavy.mass);
  assert.ok(light.inertia < medium.inertia && medium.inertia < heavy.inertia);
  assert.ok(brakingDistance(20, 7) > brakingDistance(10, 7));
  const push20 = sideHit(1, 20, 14);
  assert.ok(push20 < sideHit(1, 10, 14) && push20 > 1, '满级车更难推动，但小车仍能撼动它');
  const a = bareCar(1, 1, 0, 0, 0);
  const b = bareCar(2, 20, 0, 0, 0);
  for (let i = 0; i < 60; i++) {
    drive(a, { th: 1, st: 0 }, DT);
    drive(b, { th: 1, st: 0 }, DT);
  }
  assert.ok(a.vz > b.vz, '满级车起步应该更慢');
});

test('真人增加时，机器人只在死亡后退出', () => {
  const g = new Game({ minCars: 4, random: seeded(8) });
  const human = g.addPlayer({});
  g.spawn(human.id);
  g._balanceBots();
  const bots = [...g.players.values()].filter((p) => p.isBot);
  assert.equal(bots.length, 3);
  for (let i = 0; i < 3; i++) g.spawn(g.addPlayer({}).id);
  g._balanceBots();
  assert.equal([...g.players.values()].filter((p) => p.isBot).length, 3);
  g._kill(g.cars.get(bots[0].id));
  g._balanceBots();
  assert.equal([...g.players.values()].filter((p) => p.isBot).length, 2);
});

test('名字清洗', () => {
  assert.equal(sanitizeName('  小\u202e明\u0000  '), '小明');
  assert.equal(sanitizeName('一二三四五六七八九十十一十二'), '一二三四五六七八九十十一');
  assert.equal(sanitizeName(42), '');
});

test('重复昵称自动编号并保持长度限制，改名也不能重名', () => {
  const g = new Game({ minCars: 0, random: seeded(9) });
  const a = g.addPlayer({ name: 'abcdefghijkl' });
  const b = g.addPlayer({ name: 'abcdefghijkl' });
  const c = g.addPlayer({ name: 'abcdefghijkl' });
  assert.deepEqual([a.name, b.name, c.name], ['abcdefghijkl', 'abcdefghijk1', 'abcdefghijk2']);
  g.rename(c.id, 'abcdefghijkl');
  assert.equal(c.name, 'abcdefghijk2');
  g.removePlayer(b.id);
  g.rename(c.id, 'abcdefghijkl');
  assert.equal(c.name, 'abcdefghijk1');
});

test('随机昵称使用浏览器语言，不支持的语言使用英文，名称用完也不会重复', () => {
  for (const [locale, expected] of [['zh-CN', '小橘子'], ['en-US', 'Pudding'], ['ja-JP', 'もち'], ['ko-KR', '두부'], ['es-ES', 'Churro'], ['unknown', 'Pudding'], ['constructor', 'Pudding']]) {
    const g = new Game({ minCars: 0, random: () => 0 });
    assert.equal(g.addPlayer({ locale }).name, expected);
  }
  const g = new Game({ minCars: 0, random: () => 0 });
  const names = Array.from({ length: 100 }, () => g.addPlayer({ locale: 'ja' }).name);
  assert.equal(new Set(names).size, names.length);
});

test('快照编解码', () => {
  const g = new Game({ minCars: 0, random: seeded(4) });
  const p = g.addPlayer({});
  const car = g.spawn(p.id);
  car.vx = 3.21; car.kos = 2; car.alive = 12.34;
  const s = decodeSnapshot(encodeSnapshot(g.time, [...g.cars.values()]));
  const c = s.cars.get(p.id);
  assert.ok(Math.abs(c.x - car.x) < 0.01 && Math.abs(c.vx - 3.21) < 0.01);
  assert.equal(c.kos, 2);
  assert.equal(c.alive, 12.3);
  assert.equal(c.protect, true);
});

console.log('机器人对战（模拟 5 分钟）：');
test('1 个真人 + 3 个机器人，长时间运行稳定', () => {
  const g = new Game({ minCars: 4, random: seeded(5) });
  const human = g.addPlayer({ name: 'me' });
  g.spawn(human.id);
  let falls = 0, kos = 0, hits = 0, maxLevel = 1, maxSpeed = 0;
  const t0 = process.hrtime.bigint();
  const steps = 5 * 60 * 60;
  for (let i = 0; i < steps; i++) {
    if (!g.cars.has(human.id)) g.spawn(human.id);
    g.setInput(human.id, Math.sin(i / 50) > -0.3 ? 1 : -1, Math.sin(i / 37));
    g.step(DT);
    for (const e of g.events) {
      if (e[0] === 'fall') { falls++; if (e[2]) kos++; }
      if (e[0] === 'hit') hits++;
    }
    g.events.length = 0;
    g.deaths.length = 0;
    for (const c of g.cars.values()) {
      for (const k of ['x', 'z', 'vx', 'vz', 'h', 'w']) assert.ok(Number.isFinite(c[k]), `${k} 不是有限数`);
      maxLevel = Math.max(maxLevel, c.level);
      if (c.state === 'alive') maxSpeed = Math.max(maxSpeed, Math.hypot(c.vx, c.vz));
    }
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const bots = [...g.players.values()].filter((p) => p.isBot).length;
  console.log(`      机器人 ${bots} 个；碰撞 ${hits} 次，掉楼 ${falls} 次（其中被怼 ${kos} 次），最高 ${maxLevel} 级，最快 ${maxSpeed.toFixed(1)} m/s；每帧平均 ${(ms / steps * 1000).toFixed(1)} µs`);
  assert.equal(bots, 3);
  assert.ok(hits > 20 && falls > 3 && kos > 0);
});

test('人多了机器人自动退出', () => {
  const g = new Game({ minCars: 4, random: seeded(6) });
  for (let i = 0; i < 5; i++) g.spawn(g.addPlayer({}).id);
  for (let i = 0; i < 90; i++) g.step(DT);
  assert.equal([...g.players.values()].filter((p) => p.isBot).length, 0);
});

console.log(`\n全部 ${passed} 项通过 ✅`);
