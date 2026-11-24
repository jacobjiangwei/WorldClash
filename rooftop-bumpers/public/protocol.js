// 网络协议：服务器每秒 30 次把所有车的状态打包成二进制快照发给每个玩家。
// 服务器（编码）和浏览器（解码）共用这个文件。

export const MSG_SNAPSHOT = 1;
export const HEADER_BYTES = 11; // u8 类型 + f64 服务器时间 + u16 车辆数
export const CAR_BYTES = 25;
export const MSG_PREDICTED_SNAPSHOT = 2;
const SELF_FIELDS = ['x', 'z', 'y', 'h', 'pitch', 'roll', 'vx', 'vz', 'w', 'vy', 'pr', 'rr', 'stun', 'protect', 'alive', 'fallT'];
const SELF_BYTES = 14 + SELF_FIELDS.length * 4;
const PEER_PRED_BYTES = 4; // i8 th + i8 st + u8 protect + u8 stun

export const FLAG_FALLING = 1;
export const FLAG_PROTECT = 2;
export const FLAG_STUN = 4;

const ANGLE = 10000;

function i16(v) {
  v = Math.round(v);
  return v > 32767 ? 32767 : v < -32767 ? -32767 : v;
}

function i8(v) {
  v = Math.round(v);
  return v > 127 ? 127 : v < -127 ? -127 : v;
}

function u8(v) {
  v = Math.round(v);
  return v > 255 ? 255 : v < 0 ? 0 : v;
}

function wrap(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}

/**
 * @param {number} time 服务器时间（秒）
 * @param {Array} cars 车辆对象列表（见 src/sim.js）
 * @returns {ArrayBuffer}
 */
export function encodeSnapshot(time, cars, prediction = null) {
  const buf = new ArrayBuffer(HEADER_BYTES + cars.length * CAR_BYTES + (prediction ? SELF_BYTES + cars.length * PEER_PRED_BYTES : 0));
  const dv = new DataView(buf);
  dv.setUint8(0, prediction ? MSG_PREDICTED_SNAPSHOT : MSG_SNAPSHOT);
  dv.setFloat64(1, time, true);
  dv.setUint16(9, cars.length, true);
  let o = HEADER_BYTES;
  for (const c of cars) {
    const flags = (c.state === 'falling' ? FLAG_FALLING : 0) | (c.protect > 0 ? FLAG_PROTECT : 0) | (c.stun > 0 ? FLAG_STUN : 0);
    dv.setUint16(o, c.id, true);
    dv.setUint8(o + 2, flags);
    dv.setUint8(o + 3, c.level);
    dv.setInt16(o + 4, i16(c.x * 100), true);
    dv.setInt16(o + 6, i16(c.z * 100), true);
    dv.setInt16(o + 8, i16(c.y * 100), true);
    dv.setInt16(o + 10, i16(wrap(c.h) * ANGLE), true);
    dv.setInt16(o + 12, i16(wrap(c.pitch) * ANGLE), true);
    dv.setInt16(o + 14, i16(wrap(c.roll) * ANGLE), true);
    dv.setInt16(o + 16, i16(c.vx * 100), true);
    dv.setInt16(o + 18, i16(c.vz * 100), true);
    dv.setInt16(o + 20, i16(c.w * 1000), true);
    dv.setUint16(o + 22, Math.min(65535, Math.floor(c.alive * 10)), true);
    dv.setUint8(o + 24, Math.min(255, c.kos));
    o += CAR_BYTES;
  }
  if (prediction) {
    const { self, ack } = prediction;
    dv.setUint16(o, self?.id || 0, true);
    dv.setUint32(o + 2, ack, true);
    dv.setUint32(o + 6, self?.epoch || 0, true);
    dv.setUint32(o + 10, prediction.tick || 0, true);
    SELF_FIELDS.forEach((key, i) => dv.setFloat32(o + 14 + i * 4, self?.[key] || 0, true));
    o += SELF_BYTES;
    for (const c of cars) {
      dv.setInt8(o, i8((c.th || 0) * 100));
      dv.setInt8(o + 1, i8((c.st || 0) * 100));
      dv.setUint8(o + 2, u8((c.protect > 0 ? c.protect : 0) * 50));
      dv.setUint8(o + 3, u8((c.stun > 0 ? c.stun : 0) * 100));
      o += PEER_PRED_BYTES;
    }
  }
  return buf;
}

/** @param {ArrayBuffer} buf */
export function decodeSnapshot(buf) {
  const dv = new DataView(buf);
  if (dv.byteLength < HEADER_BYTES) return null;
  const type = dv.getUint8(0);
  if (type !== MSG_SNAPSHOT && type !== MSG_PREDICTED_SNAPSHOT) return null;
  const t = dv.getFloat64(1, true);
  const n = dv.getUint16(9, true);
  if (dv.byteLength < HEADER_BYTES + n * CAR_BYTES + (type === MSG_PREDICTED_SNAPSHOT ? SELF_BYTES + n * PEER_PRED_BYTES : 0)) return null;
  const cars = new Map();
  const order = [];
  let o = HEADER_BYTES;
  for (let i = 0; i < n; i++) {
    const flags = dv.getUint8(o + 2);
    const id = dv.getUint16(o, true);
    const car = {
      id,
      falling: (flags & FLAG_FALLING) !== 0,
      protect: (flags & FLAG_PROTECT) !== 0,
      stun: (flags & FLAG_STUN) !== 0,
      level: dv.getUint8(o + 3),
      x: dv.getInt16(o + 4, true) / 100,
      z: dv.getInt16(o + 6, true) / 100,
      y: dv.getInt16(o + 8, true) / 100,
      h: dv.getInt16(o + 10, true) / ANGLE,
      pitch: dv.getInt16(o + 12, true) / ANGLE,
      roll: dv.getInt16(o + 14, true) / ANGLE,
      vx: dv.getInt16(o + 16, true) / 100,
      vz: dv.getInt16(o + 18, true) / 100,
      w: dv.getInt16(o + 20, true) / 1000,
      alive: dv.getUint16(o + 22, true) / 10,
      kos: dv.getUint8(o + 24),
    };
    cars.set(id, car);
    order.push(car);
    o += CAR_BYTES;
  }
  if (type === MSG_PREDICTED_SNAPSHOT) {
    const id = dv.getUint16(o, true);
    const ack = dv.getUint32(o + 2, true);
    const tick = dv.getUint32(o + 10, true);
    let self = null;
    if (id && cars.has(id)) {
      self = { ...cars.get(id), epoch: dv.getUint32(o + 6, true) };
      SELF_FIELDS.forEach((key, i) => { self[key] = dv.getFloat32(o + 14 + i * 4, true); });
      self.state = self.falling ? 'falling' : 'alive';
    }
    o += SELF_BYTES;
    for (const car of order) {
      car.th = dv.getInt8(o) / 100;
      car.st = dv.getInt8(o + 1) / 100;
      car.protectTime = dv.getUint8(o + 2) / 50;
      car.stunTime = dv.getUint8(o + 3) / 100;
      o += PEER_PRED_BYTES;
    }
    return { t, tick, cars, self, ack };
  }
  return { t, cars };
}
