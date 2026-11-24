// 天台怼怼车 — 服务器与客户端预测共用的物理模拟。
// 纯 JavaScript，不依赖 Node API：所有玩家的车都在这里按同一套规律运动、碰撞、掉楼。

// ---------------------------------------------------------------------------
// 场地：楼顶停车场（单位：米）。x 方向宽 60，z 方向深 44，没有护栏。
// ---------------------------------------------------------------------------
export const WORLD = Object.freeze({
  hw: 30, // 半宽：x ∈ [-30, 30]
  hd: 22, // 半深：z ∈ [-22, 22]
  height: 150, // 大楼高度（只用于画面）
  obstacles: Object.freeze([
    { type: 'box', kind: 'stairs', x: -16, z: 1, w: 5.2, d: 4.2, h: 3.4 },
    { type: 'cyl', kind: 'tank', x: 16.5, z: -8.5, r: 2.3, h: 5.4 },
    { type: 'box', kind: 'ac', x: 7, z: 11, w: 2.8, d: 1.8, h: 1.6 },
    { type: 'box', kind: 'ac', x: -2, z: -12.5, w: 2.8, d: 1.8, h: 1.6 },
  ]),
});

// ---------------------------------------------------------------------------
// 手感与平衡参数。想调游戏手感，改这里就行。
// ---------------------------------------------------------------------------
export const TUNING = {
  maxLevel: 20,
  massPerLevel: 0.12, // 每级 +12% 体重（1.00 吨 → +120 kg）
  scalePerLevel: 0.035, // 每级车身稍微变大一点
  speedLossPerLevel: 0.025, // 每级最高速 -2.5%

  baseMaxSpeed: 15, // m/s（约 54 km/h）
  baseAccel: 11, // m/s²
  baseBrake: 18, // m/s²：刹车/倒车减速度
  baseGrip: 20, // m/s²：轮胎侧向抓地力（越小越容易被撞得横滑）
  baseTurnRate: 2.7, // rad/s
  baseSteerK: 9, // 方向盘响应速度
  baseCoast: 2.0, // m/s²：松油门时的滚动阻力
  baseSkid: 9, // m/s²：被撞懵时轮胎打滑的摩擦减速度

  // 体重对各项能力的影响指数：能力 ∝ 体重^指数。
  // 刹车指数最大 → 越重越难停下来（可以被“诱敌出界”）。
  accelExp: -0.55,
  brakeExp: -0.9,
  gripExp: -0.45,
  turnExp: -0.35,
  steerExp: -0.5,
  coastExp: -0.5,
  skidExp: -0.45,

  restitution: 0.95, // 车与车的弹性（碰碰车，弹！）
  wallRestitution: 0.5,
  stunPerSpeed: 0.06, // 被撞后“懵”的秒数 = 速度变化 × 该系数（懵的时候方向盘和油门都不听使唤）
  maxStun: 0.8,
  spawnProtect: 3, // 出生保护（幽灵状态）秒数
  koWindow: 5, // 掉楼前 5 秒内最后撞你的人算“怼下楼”
  fallTime: 2.0, // 掉下去 2 秒后判定死亡
  gravity: 26,
};

// 车身用两个圆近似（前、后），半径与偏移会随等级缩放。
export const CAR = Object.freeze({ length: 3.1, width: 1.9, circleOffset: 0.62, circleRadius: 0.95 });

export const COLORS = Object.freeze([
  '#ff6b6b', '#ffa94d', '#ffd43b', '#69db7c', '#38d9a9', '#4dabf7',
  '#748ffc', '#da77f2', '#f783ac', '#a9e34b', '#66d9e8', '#ff8787',
]);

const ZH_NAMES = [
  '小橘子', '布丁', '团子', '年糕', '豆包', '奶盖', '芝士', '汤圆', '栗子', '麻薯',
  '波波', '糯米', '果冻', '饭团', '小笼包', '椰子', '芒果', '樱桃', '草莓', '可乐',
  '酸奶', '花卷', '煎饼', '奶黄包', '烧卖', '蛋挞', '红豆', '抹茶', '布朗尼', '雪糕',
];
const PLAYER_NAMES = {
  zh: ZH_NAMES,
  en: ['Pudding', 'Peanut', 'Mochi', 'Cookie', 'Mango', 'Pickle', 'Noodle', 'Bubbles', 'Waffle', 'Sunny', 'Pepper', 'Pixel'],
  ja: ['もち', 'プリン', 'だんご', 'さくら', 'こむぎ', 'みかん', 'まろん', 'きなこ', 'おもち', 'ラムネ', 'ゆず', 'こはく'],
  ko: ['두부', '푸딩', '찹쌀', '감자', '호두', '구름', '별이', '복숭아', '젤리', '보리', '라떼', '만두'],
  es: ['Churro', 'Nube', 'Coco', 'Mango', 'Luna', 'Chispa', 'Galleta', 'Canela', 'Sol', 'Bombón'],
  fr: ['Nuage', 'Biscuit', 'Moka', 'Miel', 'Chou', 'Praline', 'Éclair', 'Pistache', 'Lune', 'Vanille'],
  de: ['Keks', 'Wolke', 'Mohn', 'Muffin', 'Stern', 'Honig', 'Flocke', 'Maus', 'Sonne', 'Waffel'],
  pt: ['Pipoca', 'Nuvem', 'Cacau', 'Manga', 'Pudim', 'Bolacha', 'Lua', 'Fubá', 'Pingo', 'Sol'],
  ru: ['Пончик', 'Плюша', 'Ириска', 'Облачко', 'Зефир', 'Печенька', 'Искра', 'Мишка', 'Панда', 'Луна'],
  ar: ['لوز', 'سكر', 'غيمة', 'قمر', 'فستق', 'مانجو', 'نجمة', 'بندق', 'لولو', 'سمسم'],
};
const BOT_NAMES = ['阿铁', '小钢', '螺丝', '齿轮', '电池', '扳手', '火花', '轮轮', '马达', '方向盘'];

const ZERO_INPUT = Object.freeze({ th: 0, st: 0 });

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const approach = (v, target, delta) => (v > target ? Math.max(target, v - delta) : Math.min(target, v + delta));
export function wrapAngle(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}
const r2 = (v) => Math.round(v * 100) / 100;

/** 清洗玩家名字：去掉控制字符/零宽字符/方向控制符，最多 12 个字。 */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return '';
  const s = raw
    .replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u115f\u1160\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(s).slice(0, 12).join('');
}

/** 某个等级的车辆参数：越重越稳，但加速、刹车、转向都更迟钝。 */
export function levelStats(level) {
  const T = TUNING;
  const L = clamp(level, 1, T.maxLevel) - 1;
  const m = 1 + T.massPerLevel * L;
  const s = 1 + T.scalePerLevel * L;
  const maxSpeed = T.baseMaxSpeed * (1 - T.speedLossPerLevel * L);
  const len = CAR.length * s;
  const wid = CAR.width * s;
  return {
    mass: m,
    scale: s,
    inertia: (m * (len * len + wid * wid)) / 12,
    maxSpeed,
    maxReverse: maxSpeed * 0.5,
    accel: T.baseAccel * Math.pow(m, T.accelExp),
    brake: T.baseBrake * Math.pow(m, T.brakeExp),
    grip: T.baseGrip * Math.pow(m, T.gripExp),
    turnRate: T.baseTurnRate * Math.pow(m, T.turnExp),
    steerK: T.baseSteerK * Math.pow(m, T.steerExp),
    coast: T.baseCoast * Math.pow(m, T.coastExp),
    skid: T.baseSkid * Math.pow(m, T.skidExp),
  };
}

function applyLevel(car, level) {
  car.level = level;
  car.p = levelStats(level);
  car.m = car.p.mass;
  car.I = car.p.inertia;
  car.s = car.p.scale;
}

/** 车辆两个碰撞圆的世界坐标。 */
function carCircles(car, out) {
  const sh = Math.sin(car.h);
  const ch = Math.cos(car.h);
  const o = CAR.circleOffset * car.s;
  const r = CAR.circleRadius * car.s;
  out[0].x = car.x + sh * o; out[0].z = car.z + ch * o; out[0].r = r;
  out[1].x = car.x - sh * o; out[1].z = car.z - ch * o; out[1].r = r;
  return out;
}
const mkCircles = () => [{ x: 0, z: 0, r: 0 }, { x: 0, z: 0, r: 0 }];
const CA = mkCircles();
const CB = mkCircles();

// ---------------------------------------------------------------------------
// 单辆车一帧的驾驶物理（街机风格的轮胎模型）
// 前进方向 f = (sin h, cos h)，右侧 r = (-cos h, sin h)。
// ---------------------------------------------------------------------------
export function drive(car, input, dt) {
  const p = car.p;

  if (car.stun > 0) {
    // 被撞懵了：轮胎打滑，往哪个方向滑都靠滑动摩擦减速；车会转着圈滑出去
    const sp = Math.hypot(car.vx, car.vz);
    if (sp > 1e-6) {
      const k = Math.max(0, sp - p.skid * dt) / sp;
      car.vx *= k;
      car.vz *= k;
    }
    car.w *= Math.max(0, 1 - 1.5 * dt);
    car.h = wrapAngle(car.h + car.w * dt);
    car.x += car.vx * dt;
    car.z += car.vz * dt;
    return;
  }

  const sh = Math.sin(car.h);
  const ch = Math.cos(car.h);
  let vf = car.vx * sh + car.vz * ch; // 纵向速度
  let vl = -car.vx * ch + car.vz * sh; // 横向速度（向右为正）
  const th = input.th;
  const st = input.st;

  if (th > 0) {
    if (vf < -0.5) vf = approach(vf, 0, p.brake * th * dt);
    else if (vf < p.maxSpeed) vf = Math.min(p.maxSpeed, vf + p.accel * th * dt);
  } else if (th < 0) {
    if (vf > 0.5) vf = approach(vf, 0, p.brake * -th * dt);
    else if (vf > -p.maxReverse) vf = Math.max(-p.maxReverse, vf + p.accel * 0.8 * th * dt);
  }
  // 滚动阻力：被撞出来的速度也会慢慢消失（越重消失得越慢）
  vf = approach(vf, 0, (th === 0 ? p.coast : p.coast * 0.25) * dt);
  // 侧向抓地（库仑摩擦）
  vl = approach(vl, 0, p.grip * dt);

  // 转向：需要速度才能转；倒车时方向反过来
  const speedFactor = Math.min(1, Math.abs(vf) / 3);
  const dir = vf >= 0 ? 1 : -1;
  const wTarget = -st * p.turnRate * speedFactor * dir;
  car.w += (wTarget - car.w) * Math.min(1, p.steerK * dt);

  car.vx = sh * vf - ch * vl;
  car.vz = ch * vf + sh * vl;
  car.h = wrapAngle(car.h + car.w * dt);
  car.x += car.vx * dt;
  car.z += car.vz * dt;
}

// ---------------------------------------------------------------------------
// 车与车碰撞：带角动量的冲量法。重车被撞得少，轻车被弹得远；偏心撞击会让车打转。
// 返回碰撞强度（接近速度），没撞上返回 0。
// ---------------------------------------------------------------------------
export function collideCars(a, b, time) {
  const reach = (CAR.circleOffset + CAR.circleRadius) * (a.s + b.s);
  const dx0 = a.x - b.x;
  const dz0 = a.z - b.z;
  if (dx0 * dx0 + dz0 * dz0 > reach * reach) return 0;

  carCircles(a, CA);
  carCircles(b, CB);
  let best = -1;
  let bi = 0;
  let bj = 0;
  for (let i = 0; i < 2; i++) {
    for (let j = 0; j < 2; j++) {
      const ddx = CA[i].x - CB[j].x;
      const ddz = CA[i].z - CB[j].z;
      const rr = CA[i].r + CB[j].r;
      const d2 = ddx * ddx + ddz * ddz;
      if (d2 < rr * rr) {
        const pen = rr - Math.sqrt(d2);
        if (pen > best) { best = pen; bi = i; bj = j; }
      }
    }
  }
  if (best < 0) return 0;

  const ci = CA[bi];
  const cj = CB[bj];
  let nx = ci.x - cj.x;
  let nz = ci.z - cj.z;
  const d = Math.hypot(nx, nz);
  if (d < 1e-6) { nx = 1; nz = 0; } else { nx /= d; nz /= d; }

  const invA = 1 / a.m;
  const invB = 1 / b.m;
  // 位置修正：按质量倒数分开
  const corr = Math.max(0, best - 0.005) / (invA + invB);
  a.x += nx * corr * invA; a.z += nz * corr * invA;
  b.x -= nx * corr * invB; b.z -= nz * corr * invB;

  // 接触点
  const px = cj.x + nx * (cj.r - best * 0.5);
  const pz = cj.z + nz * (cj.r - best * 0.5);
  const rax = px - a.x, raz = pz - a.z;
  const rbx = px - b.x, rbz = pz - b.z;
  // 接触点速度：v + ω×r，ω 绕 +y 轴：ω×r = (ω·rz, −ω·rx)
  const vax = a.vx + a.w * raz, vaz = a.vz - a.w * rax;
  const vbx = b.vx + b.w * rbz, vbz = b.vz - b.w * rbx;
  const vn = (vax - vbx) * nx + (vaz - vbz) * nz;
  if (vn >= 0) return 0; // 已在分离

  const raxn = raz * nx - rax * nz;
  const rbxn = rbz * nx - rbx * nz;
  const denom = invA + invB + (raxn * raxn) / a.I + (rbxn * rbxn) / b.I;
  const j = (-(1 + TUNING.restitution) * vn) / denom;

  a.vx += j * nx * invA; a.vz += j * nz * invA; a.w += (j * raxn) / a.I;
  b.vx -= j * nx * invB; b.vz -= j * nz * invB; b.w -= (j * rbxn) / b.I;

  const dvA = j * invA;
  const dvB = j * invB;
  if (dvA > 2) a.stun = Math.max(a.stun, Math.min(TUNING.maxStun, dvA * TUNING.stunPerSpeed));
  if (dvB > 2) b.stun = Math.max(b.stun, Math.min(TUNING.maxStun, dvB * TUNING.stunPerSpeed));
  // 记录“谁最后撞了你”，用于判定是谁把你怼下楼
  if (j > 0.15) {
    a.hitBy = b.id; a.hitAt = time;
    b.hitBy = a.id; b.hitAt = time;
  }
  return -vn;
}

// 车与障碍物（楼梯间、水箱、空调外机）碰撞
export function collideObstacles(car) {
  carCircles(car, CA);
  for (let i = 0; i < 2; i++) {
    const c = CA[i];
    for (const ob of WORLD.obstacles) {
      let nx, nz, pen;
      if (ob.type === 'cyl') {
        const dx = c.x - ob.x, dz = c.z - ob.z;
        const d = Math.hypot(dx, dz);
        pen = c.r + ob.r - d;
        if (pen <= 0) continue;
        if (d < 1e-6) { nx = 1; nz = 0; } else { nx = dx / d; nz = dz / d; }
      } else {
        const hx = ob.w / 2, hz = ob.d / 2;
        const qx = clamp(c.x, ob.x - hx, ob.x + hx);
        const qz = clamp(c.z, ob.z - hz, ob.z + hz);
        const dx = c.x - qx, dz = c.z - qz;
        const d2 = dx * dx + dz * dz;
        if (d2 > 1e-9) {
          const d = Math.sqrt(d2);
          pen = c.r - d;
          if (pen <= 0) continue;
          nx = dx / d; nz = dz / d;
        } else {
          // 圆心已经进到盒子里：沿最浅的方向推出去
          const ox = hx - Math.abs(c.x - ob.x);
          const oz = hz - Math.abs(c.z - ob.z);
          if (ox < oz) { nx = Math.sign(c.x - ob.x) || 1; nz = 0; pen = ox + c.r; }
          else { nx = 0; nz = Math.sign(c.z - ob.z) || 1; pen = oz + c.r; }
        }
      }
      car.x += nx * pen;
      car.z += nz * pen;
      c.x += nx * pen;
      c.z += nz * pen;
      const rx = c.x - nx * c.r - car.x;
      const rz = c.z - nz * c.r - car.z;
      const vx = car.vx + car.w * rz;
      const vz = car.vz - car.w * rx;
      const vn = vx * nx + vz * nz;
      if (vn < 0) {
        const rxn = rz * nx - rx * nz;
        const j = (-(1 + TUNING.wallRestitution) * vn) / (1 / car.m + (rxn * rxn) / car.I);
        car.vx += (j * nx) / car.m;
        car.vz += (j * nz) / car.m;
        car.w += (j * rxn) / car.I;
      }
    }
  }
}

export function finishDrive(car, dt) {
  car.alive += dt;
  car.protect = Math.max(0, car.protect - dt);
  car.stun = Math.max(0, car.stun - dt);
  return Math.abs(car.x) > WORLD.hw || Math.abs(car.z) > WORLD.hd;
}

export function startFall(car) {
  car.state = 'falling';
  car.fallT = 0;
  car.vy = 0;
  car.stun = 0;
  const ox = Math.abs(car.x) - WORLD.hw;
  const oz = Math.abs(car.z) - WORLD.hd;
  const nx = ox > oz ? Math.sign(car.x) : 0;
  const nz = ox > oz ? 0 : Math.sign(car.z);
  const vOut = car.vx * nx + car.vz * nz;
  if (vOut < 2.5) { car.vx += nx * (2.5 - vOut); car.vz += nz * (2.5 - vOut); }
  const sh = Math.sin(car.h), ch = Math.cos(car.h);
  const vf = car.vx * sh + car.vz * ch;
  const vl = -car.vx * ch + car.vz * sh;
  const sp = Math.hypot(vf, vl) || 1;
  car.pr = (2.8 * vf) / sp;
  car.rr = (2.8 * vl) / sp;
}

export function advanceFall(car, dt) {
  car.fallT += dt;
  car.vy -= TUNING.gravity * dt;
  car.y += car.vy * dt;
  car.x += car.vx * dt;
  car.z += car.vz * dt;
  car.pitch += car.pr * dt;
  car.roll += car.rr * dt;
  car.h = wrapAngle(car.h + car.w * dt);
}

/** 点到所有障碍物表面的最近距离（出生点选择用）。 */
function obstacleClearance(x, z) {
  let best = Infinity;
  for (const ob of WORLD.obstacles) {
    let d;
    if (ob.type === 'cyl') d = Math.hypot(x - ob.x, z - ob.z) - ob.r;
    else {
      const dx = Math.max(Math.abs(x - ob.x) - ob.w / 2, 0);
      const dz = Math.max(Math.abs(z - ob.z) - ob.d / 2, 0);
      d = Math.hypot(dx, dz);
    }
    best = Math.min(best, d);
  }
  return best;
}

/** 沿当前速度方向，离楼顶边缘还有多远（米）。 */
function distanceToEdgeAlong(x, z, vx, vz) {
  let t = Infinity;
  if (vx > 1e-3) t = Math.min(t, (WORLD.hw - x) / vx);
  else if (vx < -1e-3) t = Math.min(t, (-WORLD.hw - x) / vx);
  if (vz > 1e-3) t = Math.min(t, (WORLD.hd - z) / vz);
  else if (vz < -1e-3) t = Math.min(t, (-WORLD.hd - z) / vz);
  return t * Math.hypot(vx, vz);
}

// ---------------------------------------------------------------------------
// 游戏状态
// ---------------------------------------------------------------------------
const BOT_COUNTRIES = ['CN', 'US', 'JP', 'KR', 'GB', 'FR', 'DE', 'BR', 'CA', 'AU', 'SG', 'IN', 'IT', 'ES', 'MX'];

export class Game {
  constructor({ minCars = 10, random = Math.random } = {}) {
    this.minCars = minCars; // 真人不足时用机器人补到这个数量；0 = 不要机器人
    this.rand = random;
    this.time = 0;
    this.tick = 0;
    this.players = new Map(); // id -> 玩家（真人或机器人）
    this.cars = new Map(); // id -> 车（存活或正在掉落）。车 id = 玩家 id
    this.events = []; // 待广播事件
    this.deaths = []; // 待单独通知的死亡结算
    this.pairCooldown = new Map();
    this.rosterVersion = 0;
    this._nextId = 1;
    this._botCheckAt = 0;
    this._colorIdx = Math.floor(random() * COLORS.length);
  }

  _allocId() {
    for (let i = 0; i < 65535; i++) {
      const id = this._nextId;
      this._nextId = this._nextId >= 65535 ? 1 : this._nextId + 1;
      if (!this.players.has(id)) return id;
    }
    throw new Error('too many players');
  }

  _uniqueName(name, excludeId) {
    const used = new Set([...this.players.values()].filter((p) => p.id !== excludeId).map((p) => p.name));
    if (!used.has(name)) return name;
    for (let n = 1; ; n++) {
      const suffix = String(n);
      const candidate = Array.from(name).slice(0, Math.max(0, 12 - suffix.length)).join('') + suffix;
      if (!used.has(candidate)) return candidate;
    }
  }

  _randomName(isBot, locale) {
    const language = typeof locale === 'string' ? locale.toLowerCase().split(/[-_]/)[0] : '';
    const list = isBot ? BOT_NAMES : Object.hasOwn(PLAYER_NAMES, language) ? PLAYER_NAMES[language] : PLAYER_NAMES.en;
    const used = new Set([...this.players.values()].map((p) => p.name));
    const free = list.filter((n) => !used.has(n));
    if (free.length) return free[Math.floor(this.rand() * free.length)];
    return this._uniqueName(list[Math.floor(this.rand() * list.length)]);
  }

  addPlayer({ name, isBot = false, locale } = {}) {
    const id = this._allocId();
    this._colorIdx = (this._colorIdx + 1) % COLORS.length;
    const cleanName = sanitizeName(name);
    const p = {
      id,
      name: cleanName ? this._uniqueName(cleanName) : this._randomName(isBot, locale),
      color: COLORS[this._colorIdx],
      isBot,
      input: { th: 0, st: 0 },
      inputAt: this.time,
      deadAt: -Infinity,
      bot: isBot ? this._newBrain() : null,
      epoch: 0,
    };
    this.players.set(id, p);
    this.rosterVersion++;
    return p;
  }

  removePlayer(id) {
    this.cars.delete(id);
    if (this.players.delete(id)) this.rosterVersion++;
  }

  rename(id, name) {
    const p = this.players.get(id);
    let n = sanitizeName(name);
    if (p && n) n = this._uniqueName(n, id);
    if (p && n && n !== p.name) {
      p.name = n;
      this.rosterVersion++;
    }
  }

  setInput(id, th, st) {
    const p = this.players.get(id);
    if (!p) return;
    p.input.th = clamp(Number(th) || 0, -1, 1);
    p.input.st = clamp(Number(st) || 0, -1, 1);
    p.inputAt = this.time;
  }

  /** 玩家请求重来：现在能出生就出生，否则排队，冷却结束后自动出生。 */
  requestSpawn(id) {
    const p = this.players.get(id);
    if (!p || this.cars.has(id)) return;
    if (!this.spawn(id)) p.wantSpawn = true;
  }

  /** 出生一辆新车（1 级）。已有车或刚死不到 0.8 秒时返回 null。 */
  spawn(id) {
    const p = this.players.get(id);
    if (!p || this.cars.has(id) || this.time - p.deadAt < 0.8) return null;
    p.wantSpawn = false;
    const { x, z } = this._findSpawn();
    const car = {
      id,
      epoch: ++p.epoch,
      x, z, y: 0,
      vx: 0, vz: 0, vy: 0,
      h: Math.atan2(-x, -z), // 面向场地中央
      w: 0,
      th: 0, st: 0,
      pitch: 0, roll: 0, pr: 0, rr: 0,
      state: 'alive',
      alive: 0,
      protect: TUNING.spawnProtect,
      stun: 0,
      kos: 0,
      hitBy: 0,
      hitAt: -99,
      fallT: 0,
      killer: 0,
    };
    applyLevel(car, 1);
    this.cars.set(id, car);
    p.input.th = 0;
    p.input.st = 0;
    this.events.push(['spawn', id]);
    return car;
  }

  _findSpawn() {
    const margin = 9; // 出生点离边缘至少 9 米
    let best = { x: 0, z: 0 };
    let bestD = -1;
    for (let i = 0; i < 40; i++) {
      const x = (this.rand() * 2 - 1) * (WORLD.hw - margin);
      const z = (this.rand() * 2 - 1) * (WORLD.hd - margin);
      if (obstacleClearance(x, z) < 3.2) continue;
      let minD = 99;
      for (const c of this.cars.values()) {
        if (c.state === 'alive') minD = Math.min(minD, Math.hypot(c.x - x, c.z - z));
      }
      if (minD > bestD) { bestD = minD; best = { x, z }; }
      if (minD > 9) break;
    }
    return best;
  }

  step(dt) {
    this.time += dt;
    this.tick++;

    if (this.time >= this._botCheckAt) {
      this._balanceBots();
      this._botCheckAt = this.time + 1;
    }

    // 排队重来的真人 / 机器人思考与复活
    for (const p of this.players.values()) {
      if (!p.isBot) {
        if (p.wantSpawn) this.spawn(p.id);
        continue;
      }
      const car = this.cars.get(p.id);
      if (!car) {
        if (this.time - p.deadAt > p.bot.respawnDelay) this.spawn(p.id);
      } else if (car.state === 'alive' && (this.tick + p.id) % 3 === 0) {
        this._think(p, car);
      }
    }

    // 驾驶
    const alive = [];
    for (const car of this.cars.values()) {
      car._collided = false;
      if (car.state !== 'alive') continue;
      const p = this.players.get(car.id);
      // 真人超过 0.75 秒没发输入（掉线/切后台）就松开油门
      const input = p.isBot || this.time - p.inputAt < 0.75 ? p.input : ZERO_INPUT;
      car.th = input.th;
      car.st = input.st;
      drive(car, input, dt);
      alive.push(car);
    }

    // 碰撞（两轮迭代更稳）
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < alive.length; i++) {
        const a = alive[i];
        if (a.protect > 0) continue; // 出生保护：幽灵状态
        for (let k = i + 1; k < alive.length; k++) {
          const b = alive[k];
          if (b.protect > 0) continue;
          if ((a._clientSynced || -99) > this.time - 1 || (b._clientSynced || -99) > this.time - 1) continue;
          const pairKey = a.id < b.id ? `${a.id}:${b.id}` : `${b.id}:${a.id}`;
          if ((this.pairCooldown.get(pairKey) || -99) > this.time - 0.35) continue;
          const power = collideCars(a, b, this.time);
          if (power > 0) {
            a._collided = true;
            b._collided = true;
          }
          if (pass === 0 && power > 2.5) {
            this.events.push(['hit', r2((a.x + b.x) / 2), r2((a.z + b.z) / 2), r2(power), a.id, b.id]);
          }
        }
      }
      for (const c of alive) collideObstacles(c);
    }

    // 计时、掉楼
    for (const car of this.cars.values()) {
      if (car.state === 'alive') {
        const clientSynced = (car._clientSynced || -99) > this.time - 0.75;
        if (clientSynced && car._coasting) {
          car.x = clamp(car.x, -WORLD.hw + 0.05, WORLD.hw - 0.05);
          car.z = clamp(car.z, -WORLD.hd + 0.05, WORLD.hd - 0.05);
        }
        if (finishDrive(car, dt)) this._startFall(car);
      } else if (car.state === 'falling') {
        advanceFall(car, dt);
        if (car.fallT >= TUNING.fallTime) this._kill(car);
      }
    }
  }

  _startFall(car) {
    startFall(car);

    let killer = 0;
    if (car.hitBy && car.hitBy !== car.id && this.time - car.hitAt <= TUNING.koWindow && this.players.has(car.hitBy)) {
      killer = car.hitBy;
      const kc = this.cars.get(killer);
      if (kc && kc.state === 'alive') {
        kc.kos++;
        const level = Math.min(TUNING.maxLevel, 1 + kc.kos);
        if (level > kc.level) {
          applyLevel(kc, level);
          this.events.push(['lvl', kc.id, level]);
        }
      }
    }
    car.killer = killer;
    this.events.push(['fall', car.id, killer]);
  }

  _kill(car) {
    this.cars.delete(car.id);
    const p = this.players.get(car.id);
    if (!p) return;
    p.deadAt = this.time;
    p.input.th = 0;
    p.input.st = 0;
    if (!p.isBot) p.wantSpawn = true;
    const kp = car.killer ? this.players.get(car.killer) : null;
    this.deaths.push({
      id: car.id,
      time: r2(car.alive),
      level: car.level,
      kos: car.kos,
      by: car.killer,
      byName: kp ? kp.name : '',
    });
  }

  // ------------------------------- 机器人 -------------------------------
  _newBrain() {
    return {
      mode: 'cruise', // hunt 追 / charge 冲撞 / cruise 闲逛 / backoff 倒车蓄力 / retreat 远离边缘
      until: 0,
      target: 0,
      retargetAt: 0,
      margin: 1.5 + this.rand() * 2.5, // 胆子：离边缘多近会开始害怕
      aggression: 0.7 + this.rand() * 0.3,
      respawnDelay: 2 + this.rand() * 2,
      stuckFor: 0,
      steerBias: 0,
      wanderX: 0,
      wanderZ: 0,
      wanderAt: 0,
      noise: (this.rand() - 0.5) * 0.25,
    };
  }

  _balanceBots() {
    let humans = 0;
    const bots = [];
    for (const p of this.players.values()) {
      if (p.isBot) bots.push(p);
      else humans++;
    }
    const want = humans === 0 ? 0 : Math.max(0, this.minCars - humans);
    while (bots.length < want) {
      const p = this.addPlayer({ isBot: true });
      p.country = BOT_COUNTRIES[(p.id + Math.floor(this.rand() * BOT_COUNTRIES.length)) % BOT_COUNTRIES.length];
      this.spawn(p.id);
      bots.push(p);
    }
    if (bots.length > want) {
      for (const p of bots) {
        if (bots.length <= want) break;
        if (!this.cars.has(p.id)) {
          this.removePlayer(p.id);
          bots.splice(bots.indexOf(p), 1);
        }
      }
    }
  }

  _pickTarget(car, b) {
    const { hw, hd } = WORLD;
    let tgt = b.target ? this.cars.get(b.target) : null;
    if (tgt && tgt.state === 'alive' && tgt.protect <= 0 && this.time < b.retargetAt) return tgt;
    tgt = null;
    let best = Infinity;
    for (const c of this.cars.values()) {
      if (c === car || c.state !== 'alive' || c.protect > 0) continue;
      const d = Math.hypot(c.x - car.x, c.z - car.z) * (0.7 + this.rand() * 0.6);
      const edge = Math.min(hw - Math.abs(c.x), hd - Math.abs(c.z));
      let score = d + edge * 0.8; // 偏爱靠近边缘的目标
      if (c.alive < 8) score += 30; // 刚出生的先放过（给新玩家几秒熟悉操作）
      if (!this.players.get(c.id)?.isBot) score += 6; // 稍微偏向先打别的机器人
      if (score < best) { best = score; tgt = c; }
    }
    b.target = tgt ? tgt.id : 0;
    b.retargetAt = this.time + 3 + this.rand() * 3;
    return tgt;
  }

  _think(p, car) {
    const b = p.bot;
    const T = this.time;
    const { hw, hd } = WORLD;
    const sp = Math.hypot(car.vx, car.vz);

    // 卡住检测：一直踩油门却几乎不动
    if (sp < 1.2 && Math.abs(p.input.th) > 0.3) b.stuckFor += 0.05;
    else b.stuckFor = 0;

    // 边缘危险：按“刹车距离 + 胆量”判断。
    // 机器人总按自己 1 级时的刹车能力估算 —— 变重以后就容易刹不住、冲出边缘。
    const edgeAhead = distanceToEdgeAlong(car.x, car.z, car.vx, car.vz);
    const stopDist = (sp * sp) / (2 * TUNING.baseBrake) + sp * 0.12;
    const edgeNear = Math.min(hw - Math.abs(car.x), hd - Math.abs(car.z));
    // 冲撞时“上头”：只盯着目标，对边缘的警惕降低（可以被诱敌出界）
    const margin = b.mode === 'charge' ? b.margin * 0.25 : b.margin;
    if (b.mode !== 'retreat' && ((sp > 1 && edgeAhead < stopDist + margin) || edgeNear < 1.6)) {
      b.mode = 'retreat';
      b.until = T + 0.6 + this.rand() * 0.4;
    } else if (b.mode !== 'retreat' && b.mode !== 'backoff' && b.stuckFor > 1) {
      b.mode = 'backoff';
      b.until = T + 0.7 + this.rand() * 0.5;
      b.steerBias = this.rand() < 0.5 ? -1 : 1;
      b.stuckFor = 0;
    }
    if (b.mode !== 'hunt' && T > b.until) {
      // 冲撞 / 倒车结束后先闲逛一会儿，给大家喘口气
      if (b.mode === 'charge' || (b.mode === 'retreat' && this.rand() < 0.5)) {
        b.mode = 'cruise';
        b.until = T + 1.5 + this.rand() * 2.5;
        b.wanderAt = 0;
      } else b.mode = 'hunt';
    }

    let th = 0;
    let st = 0;
    if (b.mode === 'retreat') {
      // 朝场地中央：车头朝外就倒车，朝里就往前开
      const diff = wrapAngle(Math.atan2(-car.x, -car.z) - car.h);
      if (Math.abs(diff) > Math.PI / 2) { th = -1; st = 0; }
      else { th = 1; st = clamp(-diff * 2.2, -1, 1); }
    } else if (b.mode === 'backoff') {
      th = -1;
      st = b.steerBias * 0.6;
    } else {
      const tgt = b.mode === 'cruise' ? null : this._pickTarget(car, b);
      let ax, az;
      th = b.aggression;
      if (!tgt) {
        if (T > b.wanderAt) {
          b.wanderX = (this.rand() * 2 - 1) * (hw - 10);
          b.wanderZ = (this.rand() * 2 - 1) * (hd - 10);
          b.wanderAt = T + 3 + this.rand() * 3;
        }
        ax = b.wanderX;
        az = b.wanderZ;
        th = 0.6;
      } else {
        const d0 = Math.hypot(tgt.x - car.x, tgt.z - car.z);
        const lead = clamp(d0 / 15, 0.1, 0.5);
        const tx = tgt.x + tgt.vx * lead;
        const tz = tgt.z + tgt.vz * lead;
        const dist = Math.hypot(tx - car.x, tz - car.z);
        if (b.mode === 'charge') {
          ax = tx; az = tz; th = 1;
        } else {
          // 目标最近的边缘方向 n：绕到目标“内侧”，再把它往外撞
          const ex = hw - Math.abs(tgt.x);
          const ez = hd - Math.abs(tgt.z);
          const nx = ex < ez ? Math.sign(tgt.x) || 1 : 0;
          const nz = ex < ez ? 0 : Math.sign(tgt.z) || 1;
          const inside = (tx - car.x) * nx + (tz - car.z) * nz > 1.5;
          const angTo = wrapAngle(Math.atan2(tx - car.x, tz - car.z) - car.h);
          if (inside && dist < 10 && Math.abs(angTo) < 0.4) {
            b.mode = 'charge';
            b.until = T + 1.4;
          } else if (dist < 4.5 && sp < 3) {
            b.mode = 'backoff'; // 贴太近了，倒一下再冲
            b.until = T + 0.5 + this.rand() * 0.4;
            b.steerBias = 0;
          }
          if (inside) { ax = tx; az = tz; }
          else { ax = tx - nx * 6; az = tz - nz * 6; }
        }
      }
      if (b.mode === 'backoff') { th = -1; st = 0; }
      else st = clamp(-wrapAngle(Math.atan2(ax - car.x, az - car.z) - car.h + b.noise) * 2.2, -1, 1);
    }
    p.input.th = th;
    p.input.st = st;
  }

  // ------------------------------- 查询 -------------------------------
  humanCount() {
    let n = 0;
    for (const p of this.players.values()) if (!p.isBot) n++;
    return n;
  }
}
