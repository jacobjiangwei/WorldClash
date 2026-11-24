import assert from 'node:assert/strict';
import { Game, WORLD } from '../src/sim.js';
import { encodeSnapshot, decodeSnapshot } from '../public/protocol.js';
import { Prediction, InputQueue, STEP, MAX_PENDING } from '../public/netcode.js';

function setup(leadTicks = 0) {
  const game = new Game({ minCars: 0, random: () => 0.5 });
  const player = game.addPlayer({ name: 'driver' });
  const car = game.spawn(player.id);
  Object.assign(car, { x: 0, z: 0, h: 0, protect: 0 });
  const prediction = new Prediction({ leadTicks });
  const snapshot = (ack = 0) => decodeSnapshot(encodeSnapshot(game.time, [...game.cars.values()], {
    self: game.cars.get(player.id), ack, tick: Math.round(game.time / STEP),
  }));
  prediction.reconcile(snapshot());
  return { game, player, car, prediction, snapshot };
}

function test(name, fn) {
  fn();
  console.log('  ✓ ' + name);
}

console.log('预测与网络：');
test('输入下一物理步立即生效，不等网络往返', () => {
  const { prediction, car } = setup();
  prediction.step({ th: 1, st: 0 });
  assert.ok(prediction.car.vz > 0);
  assert.ok(prediction.sample(1, STEP).z > 0);
  assert.equal(car.z, 0, '尚未收到任何操作的服务器不能提前移动');
});

test('服务器继续滑行但确认号未变时，不能重复推进本地物理时间', () => {
  const { game, car, prediction, snapshot } = setup();
  Object.assign(car, { x: 25, vz: 6 });
  prediction.reset();
  prediction.reconcile(snapshot());
  for (let i = 0; i < 12; i++) prediction.step({ th: 0, st: 0 });
  const expected = { ...prediction.car };
  for (let tick = 1; tick <= 8; tick++) {
    game.step(STEP);
    prediction.reconcile(snapshot(0));
    assert.ok(Math.abs(prediction.car.z - expected.z) < 1e-5,
      `同一本地时刻被快照 S${tick} 多推进了 ${prediction.car.z - expected.z} m`);
    assert.ok(Math.abs(prediction.car.vz - expected.vz) < 1e-5);
  }
});

test('校正须保持插值中途的位置与显示速度连续', () => {
  const { prediction, snapshot, car } = setup();
  prediction.step({ th: 1, st: 0 });
  const before = prediction.sample(0.37, 0);
  Object.assign(car, { x: 0.5, vx: 4, h: 0.15, w: 0.7 });
  prediction.reconcile(snapshot());
  const after = prediction.sample(0.37, 0);
  for (const key of ['x', 'z', 'h', 'vx', 'vz', 'w']) {
    assert.ok(Math.abs(before[key] - after[key]) < 1e-5, `${key} 在收到快照时发生跳变`);
  }
});

test('入场先建立延迟时间线，重连重新同步，之后按键不等回包', () => {
  const { snapshot } = setup();
  const prediction = new Prediction({ leadTicks: null });
  prediction.reconcile(snapshot());
  assert.equal(prediction.step({ th: 1, st: 0 }), false);
  prediction.synchronize(400);
  assert.ok(prediction.tick >= Math.ceil(0.4 / STEP));
  assert.equal(prediction.step({ th: 1, st: 0 }), true);
  assert.ok(prediction.sample(1, STEP).z > 0);
  prediction.reset();
  prediction.reconcile(snapshot());
  assert.equal(prediction.car, null, '重连不能沿用旧连接的时间偏差');
});

test('二进制回传精确物理状态与确认编号，旧版快照仍然可读', () => {
  const { game, car } = setup();
  Object.assign(car, { stun: 0.315, protect: 0.123, vy: -4.25, fallT: 0.25, pr: 1.1 });
  const packet = encodeSnapshot(game.time, [car], { self: car, ack: 123, tick: 999 });
  const decoded = decodeSnapshot(packet);
  assert.equal(decoded.ack, 123);
  assert.equal(decoded.tick, 999);
  assert.equal(decoded.self.epoch, car.epoch);
  for (const key of ['stun', 'protect', 'vy', 'fallT', 'pr']) assert.ok(Math.abs(decoded.self[key] - car[key]) < 1e-6);
  assert.equal(decodeSnapshot(packet.slice(0, -1)), null);
  assert.equal(decodeSnapshot(encodeSnapshot(0, [car])).self, undefined);
  assert.equal(decodeSnapshot(encodeSnapshot(1, [], { self: null, ack: 124 })).self, null);
});

test('服务器逐步消费输入，重复包不能加速，非法输入不能进入队列', () => {
  const queue = new InputQueue();
  assert.ok(queue.receive(1, [[1, 0], [1, 0.5]]));
  assert.ok(queue.receive(1, [[1, 0], [1, 0.5]]));
  assert.equal(queue.frames.length, 2);
  assert.equal(queue.take().seq, 1);
  assert.equal(queue.ack, 1);
  assert.equal(queue.take().seq, 2);
  assert.equal(queue.take(), undefined);
  for (const [seq, frames] of [[0, [[1, 0]]], [3, [[NaN, 0]]], [3, [[2, 0]]], [3, null], [3, [[1]]], [3, Array(9).fill([0, 0])]]) {
    assert.equal(queue.receive(seq, frames), false);
  }
  for (let seq = 3; seq < 3 + MAX_PENDING; seq++) assert.ok(queue.receive(seq, [[1, 0]]));
  assert.equal(queue.receive(99, [[1, 0]]), false);
  queue.release();
  assert.equal(queue.frames.length, 0);
  assert.equal(queue.ack, queue.received);
});

test('网络突发积压后立即使用近期方向，而非排队执行过时油门', () => {
  const queue = new InputQueue();
  assert.ok(queue.receive(1, [[1, -1], [1, -1], [1, -1], [1, -1], [1, -1], [0, 1], [0, 1], [0, 1]]));
  const current = queue.take();
  assert.deepEqual(current, { seq: 6, th: 0, st: 1 });
  assert.equal(queue.ack, 6);
  assert.equal(queue.frames.length, 2, '保持最多两步缓冲，不积累延迟');
});

for (const delay of [4, 12, 24]) test(`${delay * 2 * STEP * 1000 | 0} ms 往返并带网络抖动时，转向持续流畅且输入历史有界`, () => {
  const { game, player, prediction } = setup();
  const queue = new InputQueue();
  const snapAt = () => {
    const liveSelf = game.cars.get(player.id);
    const self = liveSelf && liveSelf.state === 'alive' && queue.confirmed ? queue.confirmed : liveSelf;
    return decodeSnapshot(encodeSnapshot(game.time, [...game.cars.values()], {
      self, ack: queue.ack, tick: Math.round(game.time / STEP),
    }));
  };
  let upstream = [];
  let downstream = [];
  let lastUp = 0;
  let lastDown = 0;
  let lastView;
  let maxCorrection = 0;
  let maxJump = 0;
  for (let tick = 0; tick < 1200; tick++) {
    for (const packet of upstream.filter((p) => p.at <= tick)) assert.ok(queue.receive(packet.data.from, packet.data.frames));
    upstream = upstream.filter((p) => p.at > tick);
    queue.beforeStep(game, player.id, STEP);
    game.step(STEP);
    queue.afterStep(game.cars.get(player.id));
    if (tick % 2 === 0) {
      lastDown = Math.max(lastDown, tick + delay + (tick % 90 === 0 ? 4 : 0));
      downstream.push({ at: lastDown, data: snapAt() });
    }
    for (const packet of downstream.filter((p) => p.at <= tick)) {
      prediction.reconcile(packet.data);
      maxCorrection = Math.max(maxCorrection, prediction.lastCorrection);
    }
    downstream = downstream.filter((p) => p.at > tick);
    prediction.step({ th: Math.hypot(prediction.car.vx, prediction.car.vz) > 6 ? 0 : 1, st: 0.6 });
    if (tick % 2 === 0) {
      const data = prediction.packet();
      if (data) {
        lastUp = Math.max(lastUp, tick + delay + (tick % 130 === 0 ? 3 : 0));
        upstream.push({ at: lastUp, data });
      }
    }
    const current = prediction.sample(1, STEP);
    assert.ok(current, '环形驾驶期间不能掉楼或丢失本地状态');
    if (lastView) maxJump = Math.max(maxJump, Math.hypot(current.x - lastView.x, current.z - lastView.z));
    lastView = current;
    assert.ok(prediction.pending.length < MAX_PENDING, '不能累积无限输入造成越来越迟钝');
  }
  assert.ok(maxCorrection < 0.01, `最大物理校正 ${maxCorrection.toFixed(5)} m`);
  assert.ok(maxJump < 0.4, `最大单帧位移 ${maxJump.toFixed(3)} m`);
});

test('服务器校正立即改变物理，但不会把同一位置的画面瞬移', () => {
  const { prediction, snapshot, car } = setup();
  const before = prediction.sample(1, 0);
  car.x += 1;
  prediction.reconcile(snapshot());
  assert.equal(prediction.car.x, 1);
  assert.ok(Math.abs(prediction.sample(1, 0).x - before.x) < 1e-6);
  const after = prediction.sample(1, 0.2);
  assert.ok(after.x > 0.9 && after.x < 1);
});

test('预测使用相同障碍物碰撞，且在高延迟重放后仍能立即撞到其他车并同步对车画面', () => {
  const { game, car, prediction, snapshot } = setup();
  const other = game.addPlayer({ name: 'other' });
  const peer = game.spawn(other.id);
  Object.assign(car, { x: -4, z: 0, h: Math.PI / 2, vx: 14, vz: 0 });
  Object.assign(peer, { x: 0, z: 0, h: 0, protect: 0 });
  prediction.reconcile(snapshot());
  for (let i = 0; i < 15; i++) prediction.step({ th: 1, st: 0 });
  assert.ok(prediction.car.vx < 10, '尚无新的服务器快照也必须产生碰撞冲量');
  assert.ok(prediction.peers[0].vx > 0, '对车必须受到反向作用');
  assert.ok(prediction.contacts.some((e) => e[0] === 'hit'), '接触音效与弹跳应能立即触发，不等待服务器事件');
  const peerView = prediction.samplePeers(1, STEP)[0];
  assert.ok(peerView.x > 0, '接触对手的画面必须跟随预测冲量，而不是留在延迟快照的位置');
  assert.equal(car.vx, 14, '本地预测不得修改服务器状态');
  // Regression: with 20 unacknowledged frames (333 ms RTT), reconcile must NOT
  // advance this.age past the collision window or disable samplePeers/contacts.
  const highRtt = new Prediction();
  Object.assign(car, { x: -10, z: 0, h: Math.PI / 2, vx: 12, vz: 0 });
  Object.assign(peer, { x: 5, z: 0, h: Math.PI / 2, vx: 0, vz: 0, protect: 0, th: 0, st: 0 });
  highRtt.reconcile(snapshot());
  for (let i = 0; i < 20; i++) highRtt.step({ th: 1, st: 0 });
  highRtt.contacts.length = 0;
  Object.assign(car, { x: -10, z: 0, h: Math.PI / 2, vx: 12, vz: 0 });
  Object.assign(peer, { x: -3.2, z: 0, h: Math.PI / 2, vx: 0, vz: 0, protect: 0, th: 0, st: 0 });
  highRtt.reconcile(snapshot(0));
  assert.equal(highRtt.age, 0, '重放未确认帧不得消耗快照新鲜度');
  assert.equal(highRtt.samplePeers(1, STEP).length, 1, '高延迟重放后仍须返回预测对车');
  for (let i = 0; i < 6; i++) highRtt.step({ th: 1, st: 0 });
  assert.ok(highRtt.contacts.some((e) => e[0] === 'hit'), '高延迟下实时接触仍须立即触发碰撞反馈');
  const postHitX = highRtt.car.x;
  const postHitVx = highRtt.car.vx;
  const pkt = highRtt.packet();
  assert.ok(pkt?.sync, '本地碰撞后须向服务器上报碰撞同步态');
  // Pre-collision snapshot (ack < collision seq) must NOT reset the car back!
  highRtt.reconcile(snapshot(5));
  assert.ok(Math.abs(highRtt.car.x - postHitX) < 1e-5, '旧快照不得把已反弹的本地车辆重置回碰撞前位置');
  assert.ok(Math.abs(highRtt.car.vx - postHitVx) < 1e-5);
  // Server applies sync and confirms the post-collision state with 0 reset.
  const srvQueue = new InputQueue();
  for (let seq = 1; seq <= pkt.sync.seq; seq++) srvQueue.receive(seq, [[1, 0]]);
  car.protect = 0;
  car.x = postHitX - 0.5;
  assert.ok(srvQueue.applySync(game, car.id, pkt.sync));
  highRtt.reconcile(decodeSnapshot(encodeSnapshot(game.time, [...game.cars.values()], {
    self: srvQueue.confirmed, ack: srvQueue.ack, tick: Math.round(game.time / STEP),
  })));
  assert.ok(highRtt.lastCorrection < 0.01, `服务器确认碰撞后不得拉扯重置位置: ${highRtt.lastCorrection}`);
  const obstacle = WORLD.obstacles[2];
  Object.assign(car, { x: obstacle.x, z: obstacle.z - 5, h: 0, vx: 0, vz: 15 });
  const next = new Prediction();
  next.reconcile(snapshot());
  for (let i = 0; i < 25; i++) next.step({ th: 1, st: 0 });
  assert.ok(next.car.z < obstacle.z - obstacle.d / 2);
});

test('掉落仅预测运动，死亡和重生以服务器为准，旧输入不影响新生命', () => {
  const { game, player, car, prediction, snapshot } = setup();
  Object.assign(car, { x: WORLD.hw - 0.05, z: 0, h: Math.PI / 2, vx: 15 });
  prediction.reconcile(snapshot());
  prediction.step({ th: 1, st: 0 });
  assert.equal(prediction.car.state, 'falling');
  assert.ok(game.cars.has(player.id), '预测掉落不能杀死服务器上的玩家');
  game.cars.delete(player.id);
  prediction.reconcile(snapshot(1));
  assert.equal(prediction.car, null);
  assert.deepEqual(prediction.samplePeers(1, STEP), []);
  const newCar = game.spawn(player.id);
  prediction.reconcile(snapshot(1));
  assert.equal(prediction.car.epoch, newCar.epoch);
  assert.equal(prediction.pending.length, 0);
  assert.equal(prediction.seq, 0);
  prediction.step({ th: 0, st: 0 });
  assert.equal(prediction.car.vx, 0);
  assert.equal(prediction.car.vz, 0);
});

test('断网时历史有上限但驾驶不会冻结，恢复确认后可以继续操作', () => {
  const { prediction, snapshot } = setup();
  for (let i = 0; i < MAX_PENDING; i++) assert.equal(prediction.step({ th: 1, st: 0 }), true);
  const tick = prediction.tick;
  const before = { ...prediction.car };
  for (let i = 0; i < 10; i++) assert.equal(prediction.step({ th: 0, st: 1 }), true);
  assert.equal(prediction.tick, tick + 10);
  assert.ok(Math.hypot(prediction.car.x - before.x, prediction.car.z - before.z) > 0.1);
  assert.equal(prediction.pending.length, MAX_PENDING);
  assert.equal(prediction.unsent.length, MAX_PENDING);
  prediction.reconcile(snapshot(MAX_PENDING + 10));
  assert.equal(prediction.pending.length, 0);
  assert.equal(prediction.step({ th: 0, st: 0 }), true);
  prediction.release();
  assert.equal(prediction.packet(), null, '切后台前未发送的油门不能在回来后补发');
  prediction.step({ th: 0, st: 0 });
  assert.deepEqual(prediction.packet().frames, [[0, 0]]);
});
