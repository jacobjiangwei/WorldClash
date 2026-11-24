// 天台怼怼车 — 浏览器端：画面（three.js）、操作、网络、界面。
// 服务器是权威的：这里只负责把服务器发来的状态平滑地画出来，并把按键发回去。

import * as THREE from './vendor/three.module.min.js';
import { decodeSnapshot } from './protocol.js';
import { COUNTRY_CODES, FEATURED_COUNTRIES, countryName, countryFlag } from './countries.js';
import { startPromotions } from './promotions.js';
import { Prediction, STEP } from './netcode.js';
import { Game, WORLD, TUNING } from './sim.js';

// ============================================================================
// DOM
// ============================================================================
const $ = (id) => document.getElementById(id);
const ui = {
  stage: $('stage'), canvas: $('scene'),
  meDot: $('me-dot'), meName: $('me-name'), meLevel: $('me-level'), meWeight: $('me-weight'),
  meTime: $('me-time'), meKos: $('me-kos'), meBar: $('me-bar'), meNext: $('me-next'),
  boardList: $('board-list'), online: $('online'), feed: $('feed'), toast: $('toast'),
  hint: $('hint'), status: $('status'), mute: $('mute'), danger: $('danger'),
  joy: $('joy'), joyKnob: $('joy-knob'),
  death: $('death'), deathEmoji: $('death-emoji'), deathTitle: $('death-title'), deathBy: $('death-by'),
  dTime: $('d-time'), dLevel: $('d-level'), dKos: $('d-kos'), nameInput: $('name-input'), again: $('again'),
  join: $('join'), joinName: $('join-name'), countrySelect: $('country-select'), joinButton: $('join-button'),
  myCountry: $('my-country'), countryList: $('country-list'),
  diagnostics: $('diagnostics'), diagnosticsSummary: $('diagnostics-summary'), diagnosticsData: $('diagnostics-data'),
};

// ============================================================================
// 小工具
// ============================================================================
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
function wrapAngle(a) {
  a = (a + Math.PI) % (2 * Math.PI);
  if (a < 0) a += 2 * Math.PI;
  return a - Math.PI;
}
const lerpAngle = (a, b, t) => a + wrapAngle(b - a) * t;
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
function fmtTime(s) {
  s = Math.max(0, Math.floor(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
function storageGet(k) {
  try { return localStorage.getItem(k); } catch { return null; }
}
function storageSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* 隐私模式等情况下不保存 */ }
}
function mulberry32(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;

// ============================================================================
// 状态
// ============================================================================
const INTERP_DELAY = 0.12; // 其他车辆缓冲约 3~4 帧以吸收公网抖动；自己的车立即本地预测。
const prediction = new Prediction();
const localGame = new Game({ minCars: 10 });
const prevLocalCars = new Map();
let lastLocalRoster = -1;
let pendingKos = 0;
let latestScores = [];
const clientBuild = new URL(import.meta.url).searchParams.get('build') || 'dev';
let predictionTime = 0;
let inputFlushAt = 0;
const pendingSnapshots = [];
const peerKnockback = new Map();
const diagnostic = { frames: 0, seconds: 0, at: 0, fps: 0, maxFrame: 0, render: 0 };
const contactAt = new Map();
const state = {
  myId: 0,
  myName: storageGet('rb-name') || '',
  country: '',
  world: null,
  soloActive: false,
  cfg: {
    maxLevel: TUNING.maxLevel,
    massPerLevel: TUNING.massPerLevel,
    scalePerLevel: TUNING.scalePerLevel,
    speedLossPerLevel: TUNING.speedLossPerLevel,
  },
  roster: new Map(), // id -> { name, color, bot }
  rosterReady: false,
  snaps: [],
  timeOffset: null,
  renderTime: null,
  view: new Map(),
  leaderId: 0,
  dead: false,
  everSpawned: false,
  rtt: 0,
  full: false,
  interacted: false, // 用户点过/按过键之后才能震动、出声
  zoom: 1,
};
const weightOf = (level) => 1 + state.cfg.massPerLevel * (level - 1);

// ============================================================================
// 渲染器与场景
// ============================================================================
let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas: ui.canvas, antialias: true, powerPreference: 'high-performance' });
} catch {
  ui.status.hidden = false;
  ui.status.textContent = '你的浏览器不支持 WebGL，换个浏览器试试 🙏';
  throw new Error('WebGL unavailable');
}
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, isTouch ? 1 : 1.5));
renderer.shadowMap.enabled = false;
renderer.shadowMap.type = THREE.PCFShadowMap;

const scene = new THREE.Scene();
const FOG_COLOR = new THREE.Color('#cfe8ff');
scene.fog = new THREE.Fog(FOG_COLOR, 170, 950);
const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 2600);
camera.position.set(0, 60, 70);

// 天空：渐变球
const sky = new THREE.Mesh(
  new THREE.SphereGeometry(2000, 32, 16),
  new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    uniforms: {
      top: { value: new THREE.Color('#6cbcff') },
      mid: { value: FOG_COLOR.clone() },
      bottom: { value: new THREE.Color('#ffe2ef') },
    },
    vertexShader: 'varying vec3 vDir; void main() { vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: `uniform vec3 top; uniform vec3 mid; uniform vec3 bottom; varying vec3 vDir;
      void main() {
        float h = normalize(vDir).y;
        vec3 c = h > 0.0 ? mix(mid, top, smoothstep(0.0, 0.5, h)) : mix(mid, bottom, smoothstep(0.0, 0.3, -h));
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
      }`,
  }),
);
sky.renderOrder = -1;
scene.add(sky);

scene.add(new THREE.HemisphereLight(0xe3f2ff, 0xf6dcc6, 1.5));
const sun = new THREE.DirectionalLight(0xfff1dc, 2.3);
sun.position.set(26, 70, 30);
sun.castShadow = false;
scene.add(sun, sun.target);

// 卡通材质：3 阶色调
const gradientMap = new THREE.DataTexture(new Uint8Array([110, 190, 255]), 3, 1, THREE.RedFormat);
gradientMap.minFilter = THREE.NearestFilter;
gradientMap.magFilter = THREE.NearestFilter;
gradientMap.generateMipmaps = false;
gradientMap.needsUpdate = true;
const toon = (color, extra = {}) => new THREE.MeshToonMaterial({ color, gradientMap, ...extra });
const OUTLINE = new THREE.MeshBasicMaterial({ color: 0x2b2d42, side: THREE.BackSide });

function addOutline(mesh, size, t = 0.07) {
  const o = new THREE.Mesh(mesh.geometry, OUTLINE);
  o.scale.set(1 + (2 * t) / size.x, 1 + (2 * t) / size.y, 1 + (2 * t) / size.z);
  mesh.add(o);
  return o;
}

/** 带窗户图案的楼房材质（窗户按世界坐标画，楼多大窗户都一样大）。 */
function windowMaterial(color) {
  const m = new THREE.MeshLambertMaterial({ color });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp;\nvarying vec3 vWn;')
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vec4 wp4 = vec4(transformed, 1.0);
        vec3 wn3 = objectNormal;
        #ifdef USE_INSTANCING
          wp4 = instanceMatrix * wp4;
          wn3 = mat3(instanceMatrix) * wn3;
        #endif
        vWp = (modelMatrix * wp4).xyz;
        vWn = normalize(mat3(modelMatrix) * wn3);`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWp;\nvarying vec3 vWn;')
      .replace(
        '#include <color_fragment>',
        `#include <color_fragment>
        if (abs(vWn.y) < 0.5) {
          vec2 uv2 = vec2((abs(vWn.x) > 0.5 ? vWp.z : vWp.x) / 3.2, vWp.y / 3.6);
          vec2 f = fract(uv2);
          vec2 aa = fwidth(uv2) * 1.5;
          float wx = smoothstep(0.22 - aa.x, 0.22 + aa.x, f.x) * (1.0 - smoothstep(0.78 - aa.x, 0.78 + aa.x, f.x));
          float wy = smoothstep(0.30 - aa.y, 0.30 + aa.y, f.y) * (1.0 - smoothstep(0.86 - aa.y, 0.86 + aa.y, f.y));
          float cell = fract(sin(dot(floor(uv2), vec2(12.9898, 78.233))) * 43758.5453);
          vec3 glass = mix(vec3(0.42, 0.66, 0.92), vec3(1.0, 0.88, 0.55), step(0.86, cell));
          float fade = clamp(1.0 - length(aa) * 3.0, 0.0, 1.0);
          diffuseColor.rgb = mix(diffuseColor.rgb, glass, wx * wy * 0.85 * fade);
        }`,
      );
  };
  return m;
}

// ============================================================================
// 贴图（用 canvas 现画，不需要图片文件）
// ============================================================================
function canvasTexture(canvas) {
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return t;
}

function roofTexture(world) {
  const ppm = 24; // 每米像素
  const W = Math.round(world.hw * 2 * ppm);
  const H = Math.round(world.hd * 2 * ppm);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d');
  const X = (x) => (x + world.hw) * ppm;
  const Z = (z) => (z + world.hd) * ppm;
  const rnd = mulberry32(7);

  g.fillStyle = '#a3acbf';
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 9000; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(255,255,255,0.07)' : 'rgba(40,40,60,0.07)';
    const s = 1 + rnd() * 3;
    g.fillRect(rnd() * W, rnd() * H, s, s);
  }
  // 小水坑
  g.fillStyle = 'rgba(160, 210, 255, 0.45)';
  for (const [x, z, rx, rz] of [[-22, -8, 1.6, 0.9], [11, 4, 1.2, 0.7], [23, 13, 1.8, 1.0], [-7, 15, 1.1, 0.6]]) {
    g.beginPath();
    g.ellipse(X(x), Z(z), rx * ppm, rz * ppm, 0.3, 0, Math.PI * 2);
    g.fill();
  }
  // 南北两排车位
  g.strokeStyle = '#ffffff';
  g.lineWidth = 0.14 * ppm;
  g.lineCap = 'round';
  const stallW = 2.7;
  const stallD = 5.2;
  const gap = 1.6;
  for (const side of [-1, 1]) {
    const z0 = side * (world.hd - gap);
    const z1 = side * (world.hd - gap - stallD);
    for (let x = -world.hw + 4; x <= world.hw - 4 + 0.01; x += stallW) {
      g.beginPath();
      g.moveTo(X(x), Z(z0));
      g.lineTo(X(x), Z(z1));
      g.stroke();
    }
  }
  // 车道虚线 + 箭头
  g.setLineDash([2 * ppm, 1.5 * ppm]);
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  for (const [a, b] of [[-26, -20], [6, 26]]) {
    g.beginPath();
    g.moveTo(X(a), Z(0));
    g.lineTo(X(b), Z(0));
    g.stroke();
  }
  g.setLineDash([]);
  g.fillStyle = 'rgba(255,255,255,0.85)';
  const arrow = (x, z, dir) => {
    g.save();
    g.translate(X(x), Z(z));
    g.scale(dir * ppm, ppm);
    g.beginPath();
    g.moveTo(1.6, 0);
    g.lineTo(0.2, -0.9);
    g.lineTo(0.2, -0.35);
    g.lineTo(-1.6, -0.35);
    g.lineTo(-1.6, 0.35);
    g.lineTo(0.2, 0.35);
    g.lineTo(0.2, 0.9);
    g.closePath();
    g.fill();
    g.restore();
  };
  arrow(-8, -7.5, 1); arrow(14, -7.5, 1); arrow(-8, 7.5, -1); arrow(14, 7.5, -1);
  // 中央停车场标志
  g.fillStyle = '#4dabf7';
  g.strokeStyle = '#ffffff';
  g.lineWidth = 0.35 * ppm;
  g.beginPath();
  g.arc(X(0), Z(0), 3.6 * ppm, 0, Math.PI * 2);
  g.fill();
  g.stroke();
  g.fillStyle = '#ffffff';
  g.font = `900 ${4.4 * ppm}px "Arial Rounded MT Bold", "Baloo 2", Arial, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('P', X(0), Z(0.2));
  // 地面上的字
  g.font = `800 ${1.5 * ppm}px "PingFang SC", "Microsoft YaHei", sans-serif`;
  g.fillStyle = 'rgba(255, 255, 255, 0.8)';
  g.fillText('天台停车场 · 没有护栏', X(-14), Z(-world.hd + 9.6));
  g.fillStyle = 'rgba(255, 212, 59, 0.95)';
  g.fillText('小心边缘！', X(10), Z(world.hd - 9.6));
  // 边缘黄黑警示条
  const pc = document.createElement('canvas');
  pc.width = pc.height = 40;
  const pg = pc.getContext('2d');
  pg.fillStyle = '#ffd43b';
  pg.fillRect(0, 0, 40, 40);
  pg.fillStyle = '#2b2d42';
  for (let k = -40; k < 80; k += 20) {
    pg.beginPath();
    pg.moveTo(k, 0);
    pg.lineTo(k + 10, 0);
    pg.lineTo(k - 30, 40);
    pg.lineTo(k - 40, 40);
    pg.closePath();
    pg.fill();
  }
  g.fillStyle = g.createPattern(pc, 'repeat');
  const band = 0.8 * ppm;
  g.fillRect(0, 0, W, band);
  g.fillRect(0, H - band, W, band);
  g.fillRect(0, 0, band, H);
  g.fillRect(W - band, 0, band, H);
  return canvasTexture(c);
}

function groundTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#b5e3a1';
  g.fillRect(0, 0, 256, 256);
  g.fillStyle = '#d4d8e2';
  g.fillRect(0, 0, 256, 44);
  g.fillRect(0, 0, 44, 256);
  g.fillStyle = '#ffffff';
  for (let i = 56; i < 256; i += 36) {
    g.fillRect(i, 20, 16, 4);
    g.fillRect(20, i, 4, 16);
  }
  const t = canvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

function spriteTexture(draw, size = 64) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  draw(c.getContext('2d'), size);
  return canvasTexture(c);
}
const STAR_TEX = spriteTexture((g, s) => {
  g.translate(s / 2, s / 2);
  g.beginPath();
  for (let i = 0; i < 10; i++) {
    const r = i % 2 ? s * 0.2 : s * 0.46;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
  g.fillStyle = '#ffffff';
  g.fill();
});
const PUFF_TEX = spriteTexture((g, s) => {
  const grd = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.6, 'rgba(255,255,255,0.8)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, s, s);
});
const RING_TEX = spriteTexture((g, s) => {
  g.strokeStyle = '#ffffff';
  g.lineWidth = s * 0.07;
  g.beginPath();
  g.arc(s / 2, s / 2, s * 0.42, 0, Math.PI * 2);
  g.stroke();
}, 128);

// ============================================================================
// 场景：大楼、楼顶、障碍物、城市、云
// ============================================================================
function buildObstacle(ob) {
  const g = new THREE.Group();
  g.position.set(ob.x, 0, ob.z);
  const box = (w, h, d, color, x, y, z, outline = true) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), toon(color));
    m.position.set(x, y, z);
    m.castShadow = true;
    m.receiveShadow = true;
    if (outline) addOutline(m, { x: w, y: h, z: d });
    g.add(m);
    return m;
  };
  if (ob.type === 'box' && ob.kind === 'stairs') {
    box(ob.w, ob.h, ob.d, '#ffc078', 0, ob.h / 2, 0);
    box(ob.w + 0.5, 0.3, ob.d + 0.5, '#fff4e6', 0, ob.h + 0.15, 0);
    box(1.3, 2.2, 0.08, '#9c6644', 0.8, 1.1, ob.d / 2 + 0.04, false);
    box(0.9, 0.32, 0.08, '#40c057', 0.8, 2.6, ob.d / 2 + 0.04, false);
  } else if (ob.type === 'box') {
    box(ob.w, ob.h, ob.d, '#e9eef5', 0, ob.h / 2, 0);
    for (const fx of [-ob.w / 4, ob.w / 4]) {
      const fan = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.5, 0.08, 20), toon('#495057'));
      fan.position.set(fx, ob.h + 0.04, 0);
      g.add(fan);
    }
  } else {
    const legH = 1.3;
    for (const [lx, lz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) box(0.25, legH, 0.25, '#868e96', lx * ob.r * 0.6, legH / 2, lz * ob.r * 0.6, false);
    const tankH = ob.h - legH - 0.9;
    const tank = new THREE.Mesh(new THREE.CylinderGeometry(ob.r, ob.r, tankH, 28), toon('#a5d8ff'));
    tank.position.y = legH + tankH / 2;
    tank.castShadow = true;
    addOutline(tank, { x: ob.r * 2, y: tankH, z: ob.r * 2 });
    g.add(tank);
    for (const by of [0.3, 0.7]) {
      const band = new THREE.Mesh(new THREE.CylinderGeometry(ob.r + 0.04, ob.r + 0.04, 0.18, 28), toon('#4dabf7'));
      band.position.y = legH + tankH * by;
      g.add(band);
    }
    const roof = new THREE.Mesh(new THREE.ConeGeometry(ob.r * 1.06, 0.9, 28), toon('#74c0fc'));
    roof.position.y = legH + tankH + 0.45;
    roof.castShadow = true;
    g.add(roof);
  }
  return g;
}

const clouds = [];

function buildWorld(world) {
  // 大楼（楼顶就是停车场，四周没有护栏）
  const tower = new THREE.Mesh(new THREE.BoxGeometry(world.hw * 2, world.height, world.hd * 2), windowMaterial('#ffd9b8'));
  tower.position.y = -world.height / 2 - 0.03;
  scene.add(tower);
  const trim = new THREE.Mesh(new THREE.BoxGeometry(world.hw * 2 + 0.24, 0.45, world.hd * 2 + 0.24), toon('#fff4e6'));
  trim.position.y = -0.28;
  scene.add(trim);
  const roof = new THREE.Mesh(
    new THREE.PlaneGeometry(world.hw * 2, world.hd * 2).rotateX(-Math.PI / 2),
    new THREE.MeshLambertMaterial({ map: roofTexture(world) }),
  );
  roof.receiveShadow = true;
  scene.add(roof);
  for (const ob of world.obstacles) scene.add(buildObstacle(ob));

  // 城市（都比我们的楼矮）
  const ground = -world.height;
  const SP = 46;
  const groundTex = groundTexture();
  groundTex.repeat.set(130, 130);
  const groundMesh = new THREE.Mesh(new THREE.PlaneGeometry(SP * 130, SP * 130).rotateX(-Math.PI / 2), new THREE.MeshLambertMaterial({ map: groundTex }));
  groundMesh.position.set(SP / 2, ground, SP / 2);
  scene.add(groundMesh);

  const rnd = mulberry32(42);
  const pastel = ['#f8c8dc', '#c8e7f8', '#fde2b8', '#d4f0c4', '#e6d4f8', '#fff1b8', '#c9f2ee', '#f6d1c1', '#ffd6e0', '#d0ebff'];
  const blocks = [];
  for (let i = -14; i <= 14; i++) {
    for (let j = -14; j <= 14; j++) {
      const cx = i * SP;
      const cz = j * SP;
      if (Math.abs(cx) < 60 && Math.abs(cz) < 50) continue;
      const d = Math.hypot(cx, cz);
      if (d > 650 || rnd() < 0.15) continue;
      const near = Math.max(0, 1 - d / 650);
      blocks.push({
        x: cx + (rnd() - 0.5) * 6,
        z: cz + (rnd() - 0.5) * 6,
        w: 16 + rnd() * 14,
        d: 16 + rnd() * 14,
        h: Math.min(world.height - 15, 14 + rnd() * rnd() * 140 * (0.35 + near * 0.65)),
        c: pastel[Math.floor(rnd() * pastel.length)],
      });
    }
  }
  const boxGeo = new THREE.BoxGeometry(1, 1, 1).translate(0, 0.5, 0);
  const city = new THREE.InstancedMesh(boxGeo, windowMaterial('#ffffff'), blocks.length);
  const caps = new THREE.InstancedMesh(boxGeo, new THREE.MeshLambertMaterial({ color: '#ffffff' }), blocks.length);
  const m4 = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const col = new THREE.Color();
  blocks.forEach((b, k) => {
    m4.compose(new THREE.Vector3(b.x, ground, b.z), q, new THREE.Vector3(b.w, b.h, b.d));
    city.setMatrixAt(k, m4);
    city.setColorAt(k, col.set(b.c));
    m4.compose(new THREE.Vector3(b.x, ground + b.h, b.z), q, new THREE.Vector3(b.w + 1, 1.2, b.d + 1));
    caps.setMatrixAt(k, m4);
    caps.setColorAt(k, col.set(b.c).offsetHSL(0, 0.1, -0.12));
  });
  scene.add(city, caps);

  // 圆滚滚的树
  const trees = [];
  for (let i = -12; i <= 12; i++) {
    for (let j = -12; j <= 12; j++) {
      if (rnd() < 0.55) continue;
      const x = (i + 0.5) * SP + (rnd() < 0.5 ? -1 : 1) * 7;
      const z = j * SP + (rnd() - 0.5) * 20;
      if (Math.hypot(x, z) > 560 || (Math.abs(x) < 70 && Math.abs(z) < 60)) continue;
      trees.push([x, z, 3 + rnd() * 2.5]);
    }
  }
  const treeMesh = new THREE.InstancedMesh(new THREE.IcosahedronGeometry(1, 1), toon('#ffffff'), trees.length);
  trees.forEach(([x, z, s], k) => {
    m4.compose(new THREE.Vector3(x, ground + s, z), q, new THREE.Vector3(s, s * 1.1, s));
    treeMesh.setMatrixAt(k, m4);
    treeMesh.setColorAt(k, col.set(rnd() < 0.5 ? '#69db7c' : '#8ce99a'));
  });
  scene.add(treeMesh);

  // 云：有些在楼顶下面飘（站在云上面打架！）
  const cloudMat = new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0xffffff, emissiveIntensity: 0.35 });
  const puff = new THREE.SphereGeometry(1, 14, 10);
  for (let i = 0; i < 24; i++) {
    const cg = new THREE.Group();
    const n = 4 + Math.floor(rnd() * 4);
    for (let k = 0; k < n; k++) {
      const m = new THREE.Mesh(puff, cloudMat);
      const s = 4 + rnd() * 6;
      m.scale.set(s * 1.4, s * 0.8, s);
      m.position.set((k - n / 2) * 6 + rnd() * 3, rnd() * 3, (rnd() - 0.5) * 7);
      cg.add(m);
    }
    const low = i < 14;
    const z = low ? (rnd() - 0.5) * 700 : (rnd() < 0.5 ? -1 : 1) * (90 + rnd() * 300);
    cg.position.set((rnd() - 0.5) * 1000, low ? -25 - rnd() * 60 : -10 + rnd() * 50, z);
    cg.userData.speed = 1.5 + rnd() * 3;
    scene.add(cg);
    clouds.push(cg);
  }
}

// ============================================================================
// 可爱的小车：车身/车顶用玩家颜色，其余零件合并成一个网格，性能更好
// ============================================================================
function roundedBox(w, h, d, r) {
  const b = Math.min(r, h / 2 - 0.01, w / 2 - 0.01, d / 2 - 0.01);
  const sw = w - 2 * b;
  const sd = d - 2 * b;
  const rc = Math.min(b, sw / 2, sd / 2) * 0.9;
  const s = new THREE.Shape();
  s.moveTo(-sw / 2 + rc, -sd / 2);
  s.lineTo(sw / 2 - rc, -sd / 2);
  s.quadraticCurveTo(sw / 2, -sd / 2, sw / 2, -sd / 2 + rc);
  s.lineTo(sw / 2, sd / 2 - rc);
  s.quadraticCurveTo(sw / 2, sd / 2, sw / 2 - rc, sd / 2);
  s.lineTo(-sw / 2 + rc, sd / 2);
  s.quadraticCurveTo(-sw / 2, sd / 2, -sw / 2, sd / 2 - rc);
  s.lineTo(-sw / 2, -sd / 2 + rc);
  s.quadraticCurveTo(-sw / 2, -sd / 2, -sw / 2 + rc, -sd / 2);
  const geo = new THREE.ExtrudeGeometry(s, {
    depth: h - 2 * b,
    bevelEnabled: true,
    bevelThickness: b,
    bevelSize: b,
    bevelSegments: 4,
    curveSegments: 6,
  });
  geo.rotateX(-Math.PI / 2);
  geo.center();
  smoothNormals(geo);
  return geo;
}

/** 让圆角盒子看起来圆滑：同一位置的顶点共享平均法线。 */
function smoothNormals(geo) {
  const pos = geo.attributes.position;
  const n = pos.count;
  const keys = new Array(n);
  for (let i = 0; i < n; i++) keys[i] = `${pos.getX(i).toFixed(3)},${pos.getY(i).toFixed(3)},${pos.getZ(i).toFixed(3)}`;
  const sums = new Map();
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  for (let i = 0; i < n; i += 3) {
    a.fromBufferAttribute(pos, i);
    b.fromBufferAttribute(pos, i + 1);
    c.fromBufferAttribute(pos, i + 2);
    const fn = b.clone().sub(a).cross(c.clone().sub(a));
    for (let k = 0; k < 3; k++) {
      const s = sums.get(keys[i + k]);
      if (s) s.add(fn);
      else sums.set(keys[i + k], fn.clone());
    }
  }
  const nor = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const v = sums.get(keys[i]).clone().normalize();
    nor[i * 3] = v.x;
    nor[i * 3 + 1] = v.y;
    nor[i * 3 + 2] = v.z;
  }
  geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
}

function part(geo, color, x, y, z, sx = 1, sy = 1, sz = 1, rz = 0, rx = 0) {
  const g = geo.index ? geo.toNonIndexed() : geo.clone();
  const m = new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, 0, rz)),
    new THREE.Vector3(sx, sy, sz),
  );
  g.applyMatrix4(m);
  const cnt = g.attributes.position.count;
  const arr = new Float32Array(cnt * 3);
  const c = new THREE.Color(color);
  for (let i = 0; i < cnt; i++) {
    arr[i * 3] = c.r;
    arr[i * 3 + 1] = c.g;
    arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function mergeParts(list) {
  let total = 0;
  for (const g of list) total += g.attributes.position.count;
  const pos = new Float32Array(total * 3);
  const nor = new Float32Array(total * 3);
  const col = new Float32Array(total * 3);
  let o = 0;
  for (const g of list) {
    pos.set(g.attributes.position.array, o * 3);
    nor.set(g.attributes.normal.array, o * 3);
    col.set(g.attributes.color.array, o * 3);
    o += g.attributes.position.count;
  }
  const m = new THREE.BufferGeometry();
  m.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  m.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  m.setAttribute('color', new THREE.BufferAttribute(col, 3));
  m.computeBoundingSphere();
  return m;
}

const CAR_GEO = (() => {
  const paint = [];
  const fixed = [];
  const pupils = [];
  const hull = [];
  const T = 0.065; // 描边粗细
  const body = roundedBox(1.9, 0.72, 3.1, 0.27);
  paint.push(part(body, '#ffffff', 0, 0.74, 0));
  hull.push(part(body, '#000000', 0, 0.74, 0, 1 + (2 * T) / 1.9, 1 + (2 * T) / 0.72, 1 + (2 * T) / 3.1));
  const cabin = roundedBox(1.5, 0.66, 1.7, 0.25);
  fixed.push(part(cabin, '#c5ebff', 0, 1.36, -0.28));
  hull.push(part(cabin, '#000000', 0, 1.36, -0.28, 1 + (2 * T) / 1.5, 1 + (2 * T) / 0.66, 1 + (2 * T) / 1.7));
  const cap = roundedBox(1.6, 0.2, 1.8, 0.09);
  paint.push(part(cap, '#ffffff', 0, 1.72, -0.3));
  hull.push(part(cap, '#000000', 0, 1.72, -0.3, 1 + (2 * T) / 1.6, 1 + (2 * T) / 0.2, 1 + (2 * T) / 1.8));
  const bumper = roundedBox(2.02, 0.34, 0.36, 0.14);
  fixed.push(part(bumper, '#3d405b', 0, 0.5, 1.6), part(bumper, '#3d405b', 0, 0.5, -1.6));
  const wheel = new THREE.CylinderGeometry(0.38, 0.38, 0.32, 18).rotateZ(Math.PI / 2);
  const hub = new THREE.CylinderGeometry(0.17, 0.17, 0.34, 12).rotateZ(Math.PI / 2);
  for (const [x, z] of [[0.9, 1.02], [-0.9, 1.02], [0.9, -1.02], [-0.9, -1.02]]) {
    fixed.push(part(wheel, '#2b2d42', x, 0.38, z), part(hub, '#f1f3f5', x, 0.38, z));
  }
  const ball = new THREE.SphereGeometry(1, 18, 12);
  const tilt = -0.55; // 眼睛微微朝上，从高处的镜头也能看清
  for (const sx of [-1, 1]) {
    fixed.push(part(ball, '#ffffff', sx * 0.36, 1.36, 0.55, 0.3, 0.32, 0.16, 0, tilt)); // 眼白
    pupils.push(part(ball, '#1b1c2b', sx * 0.36, 1.42, 0.645, 0.145, 0.165, 0.08, 0, tilt)); // 眼珠
    pupils.push(part(ball, '#ffffff', sx * 0.36 + 0.05, 1.5, 0.665, 0.05, 0.05, 0.025, 0, tilt)); // 高光
    fixed.push(part(ball, '#ff8fab', sx * 0.6, 0.86, 1.54, 0.17, 0.1, 0.06)); // 腮红
    fixed.push(part(ball, '#fff3bf', sx * 0.74, 1.0, 1.42, 0.15, 0.12, 0.12)); // 车灯
    fixed.push(part(ball, '#ff6b6b', sx * 0.62, 0.95, -1.53, 0.16, 0.1, 0.07)); // 尾灯
  }
  const smile = new THREE.TorusGeometry(0.2, 0.045, 6, 16, Math.PI);
  fixed.push(part(smile, '#2b2d42', 0, 0.9, 1.56, 1, 1, 1, Math.PI));
  return { paint: mergeParts(paint), fixed: mergeParts(fixed), pupils: mergeParts(pupils), hull: mergeParts(hull) };
})();

const paintMats = new Map();
function paintMat(color) {
  let m = paintMats.get(color);
  if (!m) {
    m = toon(color, { vertexColors: true });
    paintMats.set(color, m);
  }
  return m;
}
const FIXED_MAT = toon('#ffffff', { vertexColors: true });
const PUPIL_MAT = new THREE.MeshBasicMaterial({ vertexColors: true });
const ANT_STICK = new THREE.CylinderGeometry(0.03, 0.03, 0.62, 6).translate(0, 0.31, 0);
const ANT_BALL = new THREE.SphereGeometry(0.12, 12, 8).translate(0, 0.66, 0);
const ANT_STICK_MAT = toon('#495057');
const ANT_BALL_MAT = toon('#ffd43b');
const CROWN_MAT = toon('#ffd43b', { side: THREE.DoubleSide });
const CROWN_RING = new THREE.CylinderGeometry(0.38, 0.33, 0.28, 10, 1, true);
const CROWN_SPIKE = new THREE.ConeGeometry(0.1, 0.24, 6);
const ME_RING_MAT = new THREE.MeshBasicMaterial({ map: RING_TEX, color: '#ffd43b', transparent: true, depthWrite: false });
const ME_RING_GEO = new THREE.PlaneGeometry(5.2, 5.2).rotateX(-Math.PI / 2);
const SHADOW_GEO = new THREE.CircleGeometry(1, 24).rotateX(-Math.PI / 2);
const SHADOW_MAT = new THREE.MeshBasicMaterial({ color: '#283747', transparent: true, opacity: 0.18, depthWrite: false });
const FLAG_GEO = new THREE.PlaneGeometry(1.3, 0.96).rotateX(-Math.PI / 2);
const EMPTY_FLAG_MAT = new THREE.MeshBasicMaterial();
const flagMaterials = new Map();
const flagLoader = new THREE.ImageLoader();

function flagMaterialsFor(country) {
  if (!flagMaterials.has(country)) {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 192;
    const texture = canvasTexture(canvas);
    flagLoader.load(`/flags/${country}.svg`, (image) => {
      canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
      texture.needsUpdate = true;
    }, undefined, (err) => {
      console.error(`无法加载 ${country} 的车顶旗帜`, err);
    });
    flagMaterials.set(country, new THREE.MeshBasicMaterial({ map: texture }));
  }
  return flagMaterials.get(country);
}

class CarView {
  constructor() {
    this.root = new THREE.Group();
    this.root.rotation.order = 'YXZ';
    this.body = new THREE.Group();
    this.root.add(this.body);
    this.paint = new THREE.Mesh(CAR_GEO.paint, paintMat('#cccccc'));
    this.fixed = new THREE.Mesh(CAR_GEO.fixed, FIXED_MAT);
    this.pupils = new THREE.Mesh(CAR_GEO.pupils, PUPIL_MAT);
    this.hull = new THREE.Mesh(CAR_GEO.hull, OUTLINE);
    this.paint.castShadow = true;
    this.fixed.castShadow = true;
    this.antenna = new THREE.Group();
    this.antenna.position.set(-0.5, 1.8, -0.92);
    this.antenna.add(new THREE.Mesh(ANT_STICK, ANT_STICK_MAT), new THREE.Mesh(ANT_BALL, ANT_BALL_MAT));
    this.crown = new THREE.Group();
    const ring = new THREE.Mesh(CROWN_RING, CROWN_MAT);
    ring.position.y = 0.14;
    this.crown.add(ring);
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const sp = new THREE.Mesh(CROWN_SPIKE, CROWN_MAT);
      sp.position.set(Math.cos(a) * 0.35, 0.38, Math.sin(a) * 0.35);
      this.crown.add(sp);
    }
    this.crown.position.set(0.63, 1.83, -0.95);
    this.crown.visible = false;
    this.flag = new THREE.Mesh(FLAG_GEO, EMPTY_FLAG_MAT);
    this.flag.position.set(0, 1.9, -0.3);
    this.flag.visible = false;
    this.country = null;
    this.body.add(this.paint, this.fixed, this.pupils, this.hull, this.antenna, this.crown, this.flag);

    this.meRing = new THREE.Mesh(ME_RING_GEO, ME_RING_MAT);
    this.meRing.visible = false;
    this.meRing.renderOrder = 2;
    this.shadow = new THREE.Mesh(SHADOW_GEO, SHADOW_MAT);

    this.tagCanvas = document.createElement('canvas');
    this.tagCanvas.width = 320;
    this.tagCanvas.height = 80;
    this.tagTex = canvasTexture(this.tagCanvas);
    this.tag = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.tagTex, transparent: true, depthWrite: false, depthTest: false }));
    this.tag.scale.set(4.6, 1.15, 1);
    this.tag.renderOrder = 10;
    this.tagKey = '';

    this.color = '';
    this.scale = 1;
    this.lean = 0;
    this.pitchV = 0;
    this.prevVf = 0;
    this.hopT = 0;
    this.hopAmp = 0;
    this.antA = 0;
    this.antV = 0;
    this.last = null;
    scene.add(this.root, this.tag, this.meRing, this.shadow);
  }

  setColor(color) {
    if (color === this.color) return;
    this.color = color;
    this.paint.material = paintMat(color);
  }

  setCountry(country) {
    if (country === this.country) return;
    this.country = country;
    this.flag.visible = !!country;
    if (country) this.flag.material = flagMaterialsFor(country);
  }

  hop(power) {
    this.hopT = 0.42;
    this.hopAmp = clamp(power / 12, 0.25, 1);
    this.antV += (Math.random() < 0.5 ? -1 : 1) * 8 * this.hopAmp;
  }

  setTag(name, level, isMe, falling) {
    const key = `${name}|${level}|${isMe}|${falling}`;
    if (key === this.tagKey) return;
    this.tagKey = key;
    const g = this.tagCanvas.getContext('2d');
    const W = this.tagCanvas.width;
    const H = this.tagCanvas.height;
    g.clearRect(0, 0, W, H);
    if (falling) {
      g.font = '56px "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText('😱', W / 2, H / 2 + 2);
    } else {
      const text = `${isMe ? '你 · ' : ''}${name}  Lv${level}`;
      let size = 34;
      g.font = `800 ${size}px "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;
      while (g.measureText(text).width > W - 40 && size > 18) {
        size -= 2;
        g.font = `800 ${size}px "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif`;
      }
      const tw = Math.min(W - 8, g.measureText(text).width + 32);
      const x0 = (W - tw) / 2;
      g.fillStyle = isMe ? '#ffd43b' : 'rgba(255, 253, 247, 0.92)';
      g.strokeStyle = '#2b2d42';
      g.lineWidth = 5;
      g.beginPath();
      if (g.roundRect) g.roundRect(x0, 10, tw, H - 20, 26);
      else g.rect(x0, 10, tw, H - 20);
      g.fill();
      g.stroke();
      g.fillStyle = '#2b2d42';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, W / 2, H / 2 + 1);
    }
    this.tagTex.needsUpdate = true;
  }

  update(s, dt, now, isMe, isLeader) {
    const target = 1 + state.cfg.scalePerLevel * (s.level - 1);
    this.scale += (target - this.scale) * Math.min(1, dt * 4);
    this.root.scale.setScalar(this.scale);
    this.root.position.set(s.x, s.y, s.z);
    this.root.rotation.set(s.pitch, s.h, s.roll);

    // 车身动态：转弯侧倾、加速抬头、被撞弹跳
    const vf = s.vx * Math.sin(s.h) + s.vz * Math.cos(s.h);
    const acc = clamp((vf - this.prevVf) / Math.max(dt, 1e-3), -40, 40);
    this.prevVf = vf;
    const leanT = s.falling ? 0 : clamp(s.w * vf * 0.012, -0.16, 0.16);
    this.lean += (leanT - this.lean) * Math.min(1, dt * 8);
    const pitchT = s.falling ? 0 : clamp(-acc * 0.005, -0.09, 0.09);
    this.pitchV += (pitchT - this.pitchV) * Math.min(1, dt * 6);
    let hopY = 0;
    let squash = 0;
    if (this.hopT > 0) {
      this.hopT = Math.max(0, this.hopT - dt);
      const k = 1 - this.hopT / 0.42;
      hopY = Math.sin(k * Math.PI) * 0.55 * this.hopAmp;
      squash = Math.sin(k * Math.PI * 2) * 0.12 * this.hopAmp;
    }
    this.body.position.y = hopY;
    this.body.scale.set(1 + squash, 1 - squash, 1 + squash);
    this.body.rotation.set(this.pitchV, 0, this.lean);

    // 眼睛：看向转弯方向；被撞懵了眼珠打转
    let px = clamp(-s.w * 0.035, -0.06, 0.06);
    let py = 0;
    if (s.stun) {
      px = Math.cos(now * 16) * 0.05;
      py = Math.sin(now * 16) * 0.05;
    } else if (s.falling) py = 0.05;
    this.pupils.position.set(px, py, 0);

    // 天线弹簧
    this.antV += (-this.antA * 140 - this.antV * 7 + acc * 0.25) * dt;
    this.antA = clamp(this.antA + this.antV * dt, -0.9, 0.9);
    this.antenna.rotation.set(this.antA, 0, this.lean * 1.5);

    this.crown.visible = isLeader && !s.falling;
    // 出生保护：闪烁
    this.root.visible = !(s.protect && Math.floor(now * 8) % 2 === 0);

    this.tag.position.set(s.x, s.y + 3.1 * this.scale + hopY, s.z);
    this.meRing.visible = isMe && !s.falling;
    this.shadow.visible = !s.falling;
    this.shadow.position.set(s.x, 0.025, s.z);
    this.shadow.rotation.y = s.h;
    this.shadow.scale.set(1.05 * this.scale, 1, 1.8 * this.scale);
    if (isMe) {
      this.meRing.position.set(s.x, 0.04, s.z);
      const pulse = 1 + Math.sin(now * 5) * 0.06;
      this.meRing.scale.setScalar(this.scale * pulse);
    }
    this.last = s;
  }

  dispose() {
    scene.remove(this.root, this.tag, this.meRing, this.shadow);
    this.tagTex.dispose();
    this.tag.material.dispose();
  }
}

const carViews = new Map();

// ============================================================================
// 特效：星星、烟雾、镜头抖动
// ============================================================================
const particles = [];
const STAR_COLORS = ['#ffd43b', '#ffffff', '#ff8fab', '#74c0fc'];
function spawnParticle(tex, x, y, z, vx, vy, vz, life, size, color, gravity = 12) {
  let p = particles.find((q) => !q.alive);
  if (!p) {
    if (particles.length >= 200) return;
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false }));
    sp.renderOrder = 5;
    scene.add(sp);
    p = { sp, v: new THREE.Vector3() };
    particles.push(p);
  }
  p.alive = true;
  p.sp.visible = true;
  p.sp.material.map = tex;
  p.sp.material.color.set(color);
  p.sp.position.set(x, y, z);
  p.v.set(vx, vy, vz);
  p.life = p.max = life;
  p.size = size;
  p.g = gravity;
}
function updateParticles(dt) {
  for (const p of particles) {
    if (!p.alive) continue;
    p.life -= dt;
    if (p.life <= 0) {
      p.alive = false;
      p.sp.visible = false;
      continue;
    }
    p.v.y -= p.g * dt;
    p.sp.position.addScaledVector(p.v, dt);
    const k = p.life / p.max;
    p.sp.material.opacity = Math.min(1, k * 2);
    p.sp.material.rotation += dt * 5;
    p.sp.scale.setScalar(p.size * (0.4 + 0.6 * k));
  }
}
function hitBurst(x, z, power) {
  const n = clamp(Math.round(power * 0.9), 5, 16);
  for (let i = 0; i < n; i++) {
    const a = Math.random() * Math.PI * 2;
    const sp = 2 + Math.random() * power * 0.45;
    spawnParticle(STAR_TEX, x, 1.3, z, Math.cos(a) * sp, 3 + Math.random() * 5, Math.sin(a) * sp, 0.5 + Math.random() * 0.35, 0.8 + Math.random() * 0.5, STAR_COLORS[i % STAR_COLORS.length]);
  }
}
function poof(x, y, z) {
  for (let i = 0; i < 12; i++) {
    const a = Math.random() * Math.PI * 2;
    spawnParticle(PUFF_TEX, x + Math.cos(a), y, z + Math.sin(a), Math.cos(a) * 2.5, 1 + Math.random() * 2, Math.sin(a) * 2.5, 0.7, 2.6, '#ffffff', 0);
  }
}
function levelBurst(x, z) {
  for (let i = 0; i < 18; i++) {
    const a = (i / 18) * Math.PI * 2;
    spawnParticle(STAR_TEX, x + Math.cos(a) * 1.6, 0.6, z + Math.sin(a) * 1.6, Math.cos(a) * 2, 7 + Math.random() * 3, Math.sin(a) * 2, 0.9, 0.9, '#ffd43b', 9);
  }
}

// ============================================================================
// 声音（WebAudio 现场合成，没有音频文件）
// ============================================================================
const sfx = (() => {
  let ctx = null;
  let muted = storageGet('rb-mute') === '1';
  function ensure() {
    if (!ctx) {
      try {
        ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch {
        return null;
      }
    }
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
    return ctx;
  }
  function tone({ type = 'sine', f0, f1 = 0, dur, vol = 0.2, delay = 0 }) {
    if (muted) return;
    const a = ensure();
    if (!a) return;
    const t = a.currentTime + delay;
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    if (f1) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(a.destination);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  return {
    unlock() {
      if (!muted) ensure();
    },
    get muted() {
      return muted;
    },
    toggle() {
      muted = !muted;
      storageSet('rb-mute', muted ? '1' : '0');
      if (!muted) ensure();
      return muted;
    },
    boing(power, vol = 1) {
      const p = clamp(power / 14, 0, 1);
      tone({ type: 'triangle', f0: 540 - p * 240, f1: 150, dur: 0.3, vol: (0.1 + 0.18 * p) * vol });
      tone({ type: 'sine', f0: 950 - p * 300, f1: 320, dur: 0.12, vol: 0.05 * vol });
    },
    fall() {
      tone({ type: 'sine', f0: 1200, f1: 150, dur: 1.5, vol: 0.16 });
    },
    ko() {
      tone({ f0: 660, dur: 0.12, vol: 0.14 });
      tone({ f0: 990, dur: 0.2, vol: 0.14, delay: 0.1 });
    },
    levelUp() {
      [523, 659, 784, 1047].forEach((f, i) => tone({ type: 'triangle', f0: f, dur: 0.2, vol: 0.13, delay: i * 0.08 }));
    },
  };
})();
ui.mute.textContent = sfx.muted ? '🔇' : '🔊';
ui.mute.addEventListener('click', () => {
  ui.mute.textContent = sfx.toggle() ? '🔇' : '🔊';
  ui.mute.blur();
});

// ============================================================================
// 界面：提示、击落播报、榜单、死亡结算
// ============================================================================
function setStatus(text) {
  ui.status.hidden = !text;
  if (text) ui.status.textContent = text;
}

let hintTimer = 0;
function showHint() {
  ui.hint.textContent = isTouch ? '按住屏幕任意处拖动 = 方向盘 · 把别人怼下楼！' : 'WASD / 方向键 开车 · 把别人怼下楼，自己别掉下去！';
  ui.hint.classList.remove('gone');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(hideHint, 12000);
}
function hideHint() {
  ui.hint.classList.add('gone');
}

function feed(parts, mine) {
  const div = document.createElement('div');
  div.className = 'feed-item' + (mine ? ' mine' : '');
  for (const p of parts) {
    if (typeof p === 'string') div.append(p);
    else {
      const b = document.createElement('b');
      b.textContent = p.name;
      div.append(b);
    }
  }
  ui.feed.prepend(div);
  while (ui.feed.children.length > 5) ui.feed.lastChild.remove();
  setTimeout(() => {
    div.style.opacity = '0';
    setTimeout(() => div.remove(), 700);
  }, 5000);
}

function toast(title, sub) {
  const d = document.createElement('div');
  d.className = 'toast-item';
  d.textContent = title;
  if (sub) {
    const s = document.createElement('small');
    s.textContent = sub;
    d.append(s);
  }
  ui.toast.append(d);
  while (ui.toast.children.length > 3) ui.toast.firstChild.remove();
  setTimeout(() => {
    d.style.opacity = '0';
    d.style.transform = 'translateY(-16px)';
    setTimeout(() => d.remove(), 600);
  }, 2400);
}

const displayName = (id) => {
  const p = state.roster.get(id);
  if (!p) return '某辆车';
  return (p.bot ? '🤖' : '') + p.name;
};

function updateBoard() {
  const alive = [...state.view.values()].filter((c) => !c.falling);
  alive.sort((a, b) => b.level - a.level || b.alive - a.alive);
  state.leaderId = alive.length > 1 ? alive[0].id : 0;
  const rows = [];
  const row = (c, rank) => {
    const li = document.createElement('li');
    if (c.id === state.myId) li.className = 'me';
    const r = document.createElement('span');
    r.className = 'rank';
    r.textContent = rank === 1 && alive.length > 1 ? '👑' : String(rank);
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = state.roster.get(c.id)?.color || '#ccc';
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = c.id === state.myId ? '你' : displayName(c.id);
    const lv = document.createElement('span');
    lv.className = 'lv';
    lv.textContent = `Lv${c.level}`;
    const ko = document.createElement('span');
    ko.className = 'ko';
    ko.textContent = `💥${c.kos}`;
    li.append(r, dot, who, lv, ko);
    return li;
  };
  alive.slice(0, 5).forEach((c, i) => rows.push(row(c, i + 1)));
  const myRank = alive.findIndex((c) => c.id === state.myId);
  if (myRank >= 5) rows.push(row(alive[myRank], myRank + 1));
  ui.boardList.replaceChildren(...rows);
  let humans = 0;
  for (const p of state.roster.values()) if (!p.bot) humans++;
  const bots = state.roster.size - humans;
  ui.online.textContent = state.soloActive
    ? `${state.roster.size} 车混战 · 积分联网同步${state.rtt ? ` (${Math.round(state.rtt)}ms)` : ''}`
    : `在线 ${humans} 人${bots ? ` · 机器人 ${bots}` : ''}${state.rtt ? ` · 延迟 ${Math.round(state.rtt)}ms` : ''}`;
}

let hudAt = 0;
let boardAt = 0;
function updateHud(now) {
  const me = state.view.get(state.myId);
  const d = me && !me.falling ? Math.min(state.world ? state.world.hw - Math.abs(me.x) : 99, state.world ? state.world.hd - Math.abs(me.z) : 99) : 99;
  ui.danger.style.opacity = clamp((3.2 - d) / 3.2, 0, 0.9).toFixed(2);
  if (now - hudAt < 0.1) return;
  hudAt = now;
  const p = state.roster.get(state.myId);
  if (p) {
    ui.meName.textContent = p.name;
    ui.meDot.style.background = p.color;
  }
  if (me && !me.falling) {
    const cfg = state.cfg;
    ui.meLevel.textContent = `Lv${me.level}`;
    ui.meWeight.textContent = `${weightOf(me.level).toFixed(2)} 吨`;
    ui.meTime.textContent = fmtTime(me.alive);
    ui.meKos.textContent = `${me.kos} 人`;
    if (me.level >= cfg.maxLevel) {
      ui.meBar.style.transform = 'scaleX(1)';
      ui.meNext.textContent = '满级！最重最稳，也最难刹车';
    } else {
      ui.meBar.style.transform = `scaleX(${(me.level - 1) / (cfg.maxLevel - 1)})`;
      ui.meNext.textContent = `击落一辆车升级（+${Math.round(cfg.massPerLevel * 1000)} kg）`;
    }
  }
  if (now - boardAt > 0.5) {
    boardAt = now;
    updateBoard();
  }
}

function showDeath(d) {
  toast(d.by ? '被怼下楼啦！' : '掉下楼啦！', '马上从 1 级重新出发');
}
function hideDeath() {
  state.dead = false;
  ui.death.hidden = true;
}
function respawn() {
  const name = ui.nameInput.value.trim();
  if (name) {
    state.myName = name;
    storageSet('rb-name', name);
    if (state.soloActive && state.myId) localGame.rename(state.myId, name);
  }
  if (state.soloActive && state.myId) localGame.requestSpawn(state.myId);
  else send({ t: 'respawn', name: name || undefined });
  hideDeath();
  sfx.unlock();
}
ui.again.addEventListener('click', respawn);

function renderScores(list) {
  latestScores = list;
  const rows = list.slice(0, 5).map(([code, score]) => {
    const li = document.createElement('li');
    li.textContent = `${countryFlag(code)} ${countryName(code)} · ${score} 分`;
    return li;
  });
  if (!rows.length) {
    const li = document.createElement('li');
    li.textContent = '今天还没有积分';
    rows.push(li);
  }
  ui.countryList.replaceChildren(...rows);
  const mine = list.find(([code]) => code === state.country);
  ui.myCountry.textContent = `${countryFlag(state.country)} ${countryName(state.country)} · ${mine ? mine[1] : 0} 分`;
}

function reportKnockout() {
  if (!state.country) return;
  const next = latestScores.map(([c, s]) => [c, s]);
  const entry = next.find(([c]) => c === state.country);
  if (entry) entry[1] += 1;
  else next.push([state.country, 1]);
  next.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  renderScores(next);
  if (ws && ws.readyState === WebSocket.OPEN) {
    send({ t: 'ko', country: state.country });
  } else {
    pendingKos++;
  }
}

function startLocalGame() {
  if (!state.world) {
    buildWorld(WORLD);
    state.worldAt = performance.now();
  }
  state.world = WORLD;
  setStatus(null);
  hideDeath();
  if (!state.soloActive) {
    state.soloActive = true;
    const p = localGame.addPlayer({ name: state.myName, locale: navigator.language || 'zh-CN' });
    p.country = state.country;
    state.myId = p.id;
    localGame.spawn(p.id);
    localGame._balanceBots();
    syncLocalRoster();
    syncLocalView(1);
    if (!state.everSpawned) {
      state.everSpawned = true;
      showHint();
      toast('10 车大混战开始！', '黄色圈圈里就是你的车，怼人下楼为国家加分');
    }
  }
}

function syncLocalRoster() {
  if (localGame.rosterVersion === lastLocalRoster) return;
  lastLocalRoster = localGame.rosterVersion;
  const next = new Map();
  for (const [id, p] of localGame.players) {
    next.set(id, { name: p.name, color: p.color, bot: !!p.isBot, country: p.country || null });
  }
  state.roster = next;
  state.rosterReady = true;
}

function syncLocalView(alpha) {
  const out = state.view;
  out.clear();
  for (const [id, car] of localGame.cars) {
    const prev = prevLocalCars.get(id) || car;
    out.set(id, {
      id: car.id,
      epoch: car.epoch,
      falling: car.state === 'falling',
      protect: car.protect > 0,
      stun: car.stun > 0,
      level: car.level,
      kos: car.kos,
      x: lerp(prev.x, car.x, alpha),
      z: lerp(prev.z, car.z, alpha),
      y: lerp(prev.y, car.y, alpha),
      h: lerpAngle(prev.h, car.h, alpha),
      pitch: lerpAngle(prev.pitch, car.pitch, alpha),
      roll: lerpAngle(prev.roll, car.roll, alpha),
      vx: car.vx,
      vz: car.vz,
      w: car.w,
      alive: car.alive,
    });
  }
  const myCar = localGame.cars.get(state.myId) || null;
  prediction.car = myCar;
  prediction.serverTick = localGame.tick;
  prediction.epoch = myCar?.epoch || 1;
  prediction.seq = localGame.tick;
  prediction.ack = localGame.tick;
  prediction.lastCorrection = 0;
  state.viewTick = localGame.tick;
}

// ============================================================================
// 网络（仅用于同步全球国家积分排行榜与版本诊断，不干预本地物理）
// ============================================================================
let ws = null;
let reconnectDelay = 1000;

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  if (!state.soloActive) setStatus(state.full ? '天台挤满了，稍后自动重试…' : '正在连接游戏服务器…');
  const params = new URLSearchParams({ country: state.country, name: state.myName, locale: navigator.language || 'en', mode: 'solo' });
  const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?${params}`;
  try {
    ws = new WebSocket(url);
  } catch {
    scheduleReconnect();
    return;
  }
  ws.binaryType = 'arraybuffer';
  ws.onopen = () => {
    reconnectDelay = 1000;
    while (pendingKos > 0 && ws.readyState === WebSocket.OPEN) {
      pendingKos--;
      send({ t: 'ko', country: state.country });
    }
  };
  ws.onmessage = (e) => {
    if (typeof e.data === 'string') onJson(e.data);
    else if (!state.soloActive) onSnapshot(e.data);
  };
  ws.onclose = () => {
    ws = null;
    if (!state.soloActive) {
      state.myId = 0;
      state.snaps = [];
      state.view.clear();
      state.timeOffset = null;
      state.renderTime = null;
      pendingSnapshots.length = 0;
      peerKnockback.clear();
      prediction.reset();
      contactAt.clear();
      predictionTime = 0;
      for (const cv of carViews.values()) cv.dispose();
      carViews.clear();
      hideDeath();
      setStatus(state.full ? '天台挤满了，稍后自动重试…' : '连接断开了，正在重连…');
    }
    scheduleReconnect();
  };
  ws.onerror = () => {};
}
function scheduleReconnect() {
  setTimeout(connect, state.full ? 10000 : reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.7, 8000);
}

function onJson(text) {
  let m;
  try {
    m = JSON.parse(text);
  } catch {
    return;
  }
  switch (m.t) {
    case 'welcome': {
      state.full = false;
      state.build = m.build;
      state.instance = m.instance;
      send({ t: 'ping', c: performance.now() });
      if (!state.soloActive) {
        state.myId = m.id;
        state.cfg = { ...state.cfg, ...m.cfg };
        state.prediction = m.prediction === true;
        if (!state.world) {
          buildWorld(m.world);
          state.worldAt = performance.now();
        }
        state.world = m.world;
        setStatus(null);
        hideDeath();
        if (!state.everSpawned) {
          state.everSpawned = true;
          showHint();
          toast('你来到天台了！', '黄色圈圈里就是你的车');
        }
      }
      break;
    }
    case 'roster': {
      if (state.soloActive) break;
      const next = new Map(m.list.map(([id, name, color, bot, country]) => [id, { name, color, bot: !!bot, country }]));
      if (state.rosterReady) {
        for (const [id, p] of next) {
          if (!p.bot && !state.roster.has(id) && id !== state.myId) feed([{ name: p.name }, ' 来到了天台 👋'], false);
        }
      }
      state.roster = next;
      state.rosterReady = true;
      break;
    }
    case 'ev':
      if (!state.soloActive) for (const e of m.e) onEvent(e);
      break;
    case 'dead':
      if (!state.soloActive) showDeath(m);
      break;
    case 'scores': {
      renderScores(m.scores);
      break;
    }
    case 'scoreError':
      toast('国家积分保存失败', '本次击落未计入积分，请联系管理员');
      break;
    case 'pong':
      state.rtt = performance.now() - m.c;
      prediction.synchronize(state.rtt);
      setStatus(null);
      break;
    case 'full':
      state.full = true;
      break;
    default:
      break;
  }
}

function onEvent(e) {
  const kind = e[0];
  const me = state.myId;
  if (kind === 'hit') {
    const [, x, z, power, a, b] = e;
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const now = performance.now();
    const previous = contactAt.get(key);
    if (previous !== undefined && now - previous < 350) return;
    for (const [pair, at] of contactAt) if (now - at > 1000) contactAt.delete(pair);
    contactAt.set(key, now);
    hitBurst(x, z, power);
    carViews.get(a)?.hop(power);
    carViews.get(b)?.hop(power);
    const mine = a === me || b === me;
    const cx = camera.position.x;
    const cz = camera.position.z;
    if (mine) {
      sfx.boing(power, 1);
      camShake = Math.min(1.2, camShake + power * 0.06);
      const activated = navigator.userActivation ? navigator.userActivation.hasBeenActive : state.interacted;
      if (activated && navigator.vibrate) navigator.vibrate(Math.min(60, power * 4));
    } else if (Math.hypot(x - cx, z - cz) < 60) sfx.boing(power, 0.4);
  } else if (kind === 'fall') {
    const [, id, killer] = e;
    const mine = id === me || killer === me;
    if (killer) feed([{ name: id === me ? '你' : displayName(id) }, ' 被 ', { name: killer === me ? '你' : displayName(killer) }, ' 怼下楼了！'], mine);
    else feed([{ name: id === me ? '你' : displayName(id) }, ' ' + pick(['自己冲下楼了 😵', '一脚油门飞出了天台 🕊️', '没刹住车 🫠'])], mine);
    if (id === me) sfx.fall();
    else if (killer === me) {
      sfx.ko();
      toast('怼下去一个！', `${displayName(id)} 掉下楼了`);
    }
  } else if (kind === 'lvl') {
    const [, id, lvl] = e;
    if (id === me) {
      const s = state.view.get(me);
      if (s) levelBurst(s.x, s.z);
      sfx.levelUp();
      toast(`升级！Lv${lvl} 🍔`, `体重 ${weightOf(lvl).toFixed(2)} 吨：更难被推走，但更难刹车`);
    }
  } else if (kind === 'spawn') {
    const [, id] = e;
    if (id === me) hideDeath();
  }
}

function onSnapshot(buf) {
  const s = decodeSnapshot(buf);
  if (!s) return;
  if (!prediction.car) prediction.reconcile(s);
  else pendingSnapshots.push(s);
  const off = s.t - performance.now() / 1000;
  if (state.timeOffset === null || Math.abs(off - state.timeOffset) > 1) state.timeOffset = off;
  else state.timeOffset += (off - state.timeOffset) * 0.05;
  state.snaps.push(s);
  if (state.snaps.length > 60) state.snaps.splice(0, state.snaps.length - 60);
}

function mixCar(a, b, t) {
  return {
    id: b.id,
    falling: b.falling,
    protect: b.protect,
    stun: b.stun,
    level: b.level,
    kos: b.kos,
    x: lerp(a.x, b.x, t),
    z: lerp(a.z, b.z, t),
    y: lerp(a.y, b.y, t),
    h: lerpAngle(a.h, b.h, t),
    pitch: lerpAngle(a.pitch, b.pitch, t),
    roll: lerpAngle(a.roll, b.roll, t),
    vx: lerp(a.vx, b.vx, t),
    vz: lerp(a.vz, b.vz, t),
    w: lerp(a.w, b.w, t),
    alive: lerp(a.alive, b.alive, t),
  };
}

/** 取“现在该画的”所有车的状态（两帧快照插值 + 二阶无超调速度跟随，绝不倒退或抽动）。 */
function sampleView(now, rawDt = STEP) {
  const out = state.view;
  out.clear();
  const snaps = state.snaps;
  if (!snaps.length || state.timeOffset === null) return out;
  const targetRt = now + state.timeOffset - INTERP_DELAY;
  if (state.renderTime === null || Math.abs(targetRt - state.renderTime) > 1) {
    state.renderTime = targetRt;
  } else {
    const rate = clamp(1 + (targetRt - state.renderTime) * 3, 0.85, 1.15);
    state.renderTime += Math.max(0, rawDt) * rate;
  }
  const rt = state.renderTime;
  state.viewTick = Math.max(0, Math.floor(rt / STEP));
  while (snaps.length > 1 && snaps[1].t <= rt) snaps.shift();
  const a = snaps[0];
  const b = snaps[1];
  const rawTargets = new Map();
  if (!b) {
    const ex = clamp(rt - a.t, 0, 0.18);
    for (const [id, c] of a.cars) {
      rawTargets.set(id, c.falling || ex === 0 ? c : { ...c, x: c.x + c.vx * ex, z: c.z + c.vz * ex, h: wrapAngle(c.h + c.w * ex) });
    }
  } else if (rt <= a.t) {
    for (const [id, c] of a.cars) rawTargets.set(id, c);
  } else {
    const span = Math.max(1e-4, b.t - a.t);
    const t = clamp((rt - a.t) / span, 0, 1);
    for (const [id, cb] of b.cars) {
      const ca = a.cars.get(id);
      rawTargets.set(id, ca ? mixCar(ca, cb, t) : cb);
    }
  }
  const dt = clamp(rawDt, 0.001, 0.05);
  const blend = 1 - Math.exp(-dt * 14);
  for (const id of peerKnockback.keys()) {
    if (!rawTargets.has(id)) peerKnockback.delete(id);
  }
  for (const [id, target] of rawTargets) {
    if (id === state.myId) {
      out.set(id, target);
      continue;
    }
    const cur = peerKnockback.get(id);
    if (!cur || cur.falling !== target.falling || Math.hypot(target.x - cur.x, target.z - cur.z) > 6) {
      const init = { ...target };
      peerKnockback.set(id, init);
      out.set(id, init);
      continue;
    }
    const desiredVx = target.vx + (target.x - (cur.x + cur.vx * dt)) * 4.5;
    const desiredVz = target.vz + (target.z - (cur.z + cur.vz * dt)) * 4.5;
    const desiredW = target.w + wrapAngle(target.h - (cur.h + cur.w * dt)) * 5;
    cur.vx += (desiredVx - cur.vx) * blend;
    cur.vz += (desiredVz - cur.vz) * blend;
    cur.w += (desiredW - cur.w) * blend;
    cur.x += cur.vx * dt;
    cur.z += cur.vz * dt;
    cur.y = target.y;
    cur.h = wrapAngle(cur.h + cur.w * dt);
    cur.pitch = lerpAngle(cur.pitch, target.pitch, blend);
    cur.roll = lerpAngle(cur.roll, target.roll, blend);
    cur.falling = target.falling;
    cur.protect = target.protect;
    cur.stun = target.stun;
    cur.level = target.level;
    cur.kos = target.kos;
    cur.alive = target.alive;
    out.set(id, { ...cur });
  }
  return out;
}

function syncCars(dt, now) {
  for (const [id, s] of state.view) {
    let cv = carViews.get(id);
    if (!cv) {
      cv = new CarView();
      carViews.set(id, cv);
    }
    const p = state.roster.get(id);
    cv.setColor(p ? p.color : '#cccccc');
    cv.setCountry(p?.bot ? null : p?.country || (id === state.myId ? state.country : null));
    cv.update(s, dt, now, id === state.myId, id === state.leaderId);
    cv.setTag(p ? (p.bot ? '🤖' : '') + p.name : '…', s.level, id === state.myId, s.falling);
  }
  for (const [id, cv] of carViews) {
    if (state.view.has(id)) continue;
    if (cv.last && !cv.last.falling) poof(cv.last.x, 1, cv.last.z);
    cv.dispose();
    carViews.delete(id);
  }
}

// ============================================================================
// 操作：键盘 + 触屏摇杆
// ============================================================================
const keys = new Set();
const KEYMAP = {
  KeyW: 'up', ArrowUp: 'up', KeyS: 'down', ArrowDown: 'down',
  KeyA: 'left', ArrowLeft: 'left', KeyD: 'right', ArrowRight: 'right',
};
addEventListener('keydown', (e) => {
  if (e.target === ui.joinName) return;
  if (e.target === ui.nameInput) {
    if (e.key === 'Enter') {
      e.preventDefault();
      respawn();
    }
    return;
  }
  if (!ui.death.hidden && (e.key === 'Enter' || e.key === ' ')) {
    e.preventDefault();
    respawn();
    return;
  }
  const k = KEYMAP[e.code];
  if (k) {
    keys.add(k);
    e.preventDefault();
    hideHint();
    state.interacted = true;
    sfx.unlock();
  }
});
addEventListener('keyup', (e) => {
  const k = KEYMAP[e.code];
  if (k) keys.delete(k);
});
const joy = { active: false, id: -1, ox: 0, oy: 0, dx: 0, dy: 0 };
const JOY_MAX = 55;
ui.stage.addEventListener('pointerdown', (e) => {
  state.interacted = true;
  sfx.unlock();
  hideHint();
  if (joy.active) return;
  joy.active = true;
  joy.id = e.pointerId;
  joy.ox = e.clientX;
  joy.oy = e.clientY;
  joy.dx = 0;
  joy.dy = 0;
  try {
    ui.stage.setPointerCapture(e.pointerId);
  } catch { /* ignore */ }
  ui.joy.hidden = false;
  ui.joy.style.left = `${e.clientX}px`;
  ui.joy.style.top = `${e.clientY}px`;
  ui.joyKnob.style.transform = '';
});
ui.stage.addEventListener('pointermove', (e) => {
  if (!joy.active || e.pointerId !== joy.id) return;
  let dx = e.clientX - joy.ox;
  let dy = e.clientY - joy.oy;
  const len = Math.hypot(dx, dy);
  if (len > JOY_MAX) {
    dx *= JOY_MAX / len;
    dy *= JOY_MAX / len;
  }
  joy.dx = dx;
  joy.dy = dy;
  ui.joyKnob.style.transform = `translate(${dx}px, ${dy}px)`;
});
// 鼠标滚轮缩放镜头
ui.stage.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault();
    state.zoom = clamp(state.zoom * Math.exp(e.deltaY * 0.0012), 0.45, 1.8);
  },
  { passive: false },
);

function endJoy(e) {
  if (e.pointerId !== joy.id) return;
  joy.active = false;
  joy.id = -1;
  ui.joy.hidden = true;
}
ui.stage.addEventListener('pointerup', endJoy);
ui.stage.addEventListener('pointercancel', endJoy);

function currentInput(me) {
  if (joy.active) {
    const len = Math.hypot(joy.dx, joy.dy);
    if (len < 8) return { th: 0, st: 0 };
    // 摇杆指向屏幕上的方向，车就往那个方向开（镜头朝 -z：屏幕右 = +x，屏幕下 = +z）
    const desired = Math.atan2(joy.dx, joy.dy);
    const diff = wrapAngle(desired - me.h);
    const mag = Math.min(1, len / JOY_MAX);
    return { th: Math.abs(diff) > 2.3 ? 0.5 * mag : mag, st: clamp(-diff * 2, -1, 1) };
  }
  let th = 0;
  let st = 0;
  if (keys.has('up')) th += 1;
  if (keys.has('down')) th -= 1;
  if (keys.has('left')) st -= 1;
  if (keys.has('right')) st += 1;
  return { th, st };
}

function flushInputs() {
  if (!ws || ws.readyState !== WebSocket.OPEN || ws.bufferedAmount > 8192) return;
  let packet;
  while ((packet = prediction.packet())) send(packet);
}

function releaseInput() {
  keys.clear();
  joy.active = false;
  joy.id = -1;
  joy.dx = joy.dy = 0;
  ui.joy.hidden = true;
  prediction.release();
  send({ t: 'release' });
  predictionTime = 0;
}
addEventListener('blur', releaseInput);
document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseInput();
});
setInterval(() => send({ t: 'ping', c: performance.now() }), 2000);

// ============================================================================
// 镜头
// ============================================================================
let camShake = 0;
let orbit = 0;
const camPos = new THREE.Vector3(0, 70, 80);
const camLook = new THREE.Vector3(0, 0, 0);
const wantPos = new THREE.Vector3();
const wantLook = new THREE.Vector3();
const hold = { x: 0, z: 0 };

function updateCamera(dt, me) {
  const k = clamp(Math.pow(1.4 / camera.aspect, 0.8), 1, 1.9) * state.zoom; // 竖屏时拉远一点；滚轮可缩放
  if (me && !me.falling) {
    hold.x = me.x;
    hold.z = me.z;
    wantLook.set(hold.x, 0, hold.z - 1.5);
    wantPos.set(hold.x, 24 * k, hold.z + 20 * k);
  } else if (me && me.falling) {
    // 自己掉下去：镜头停在楼边，低头看着车一路掉下去
    wantLook.set(me.x, Math.max(me.y, -48), me.z);
    wantPos.set(hold.x, 24 * k, hold.z + 20 * k);
  } else {
    // 观战：绕着楼顶慢慢转
    orbit += dt * 0.08;
    const R = 62 * k;
    wantPos.set(Math.sin(orbit) * R, 50 * k, Math.cos(orbit) * R);
    wantLook.set(0, -6, 0);
  }
  const f = 1 - Math.exp(-dt * 10);
  camPos.lerp(wantPos, f);
  camLook.lerp(wantLook, me && me.falling ? 1 - Math.exp(-dt * 8) : f);
  camera.position.copy(camPos);
  if (camShake > 0.002) {
    camera.position.x += (Math.random() - 0.5) * camShake;
    camera.position.y += (Math.random() - 0.5) * camShake;
    camShake *= Math.exp(-dt * 7);
  }
  camera.lookAt(camLook);
}

function resize() {
  const w = window.innerWidth;
  const h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ============================================================================
// 画质自适应：低端手机帧率太低时，先降分辨率，再关阴影（网址加 ?low 直接用低画质）
// ============================================================================
const quality = { frames: 0, time: 0, slow: 0, level: 0 };
function setQuality(level) {
  quality.level = level;
  renderer.setPixelRatio(level >= 2 ? 0.75 : 1);
  resize();
}
function adaptQuality(rawDt) {
  if (quality.level >= 2 || document.hidden || rawDt > 0.25) return;
  if (!state.worldAt || performance.now() - state.worldAt < 2000) return; // 刚加载时在编译着色器，先不算
  quality.frames++;
  quality.time += rawDt;
  if (rawDt > 0.025) quality.slow++;
  if (quality.time < 2) return;
  const fps = quality.frames / quality.time;
  const uneven = quality.slow / quality.frames > 0.08;
  quality.frames = 0;
  quality.time = 0;
  quality.slow = 0;
  if (fps < 55 || uneven) setQuality(quality.level + 1);
}
if (new URLSearchParams(location.search).has('low')) setQuality(2);
ui.diagnostics.open = new URLSearchParams(location.search).has('debug');

function updateDiagnostics(now, rawDt) {
  diagnostic.render++;
  diagnostic.frames++;
  diagnostic.seconds += rawDt;
  diagnostic.maxFrame = Math.max(diagnostic.maxFrame, rawDt * 1000);
  if (now - diagnostic.at < 0.5) return;
  diagnostic.at = now;
  diagnostic.fps = Math.round(diagnostic.frames / Math.max(diagnostic.seconds, 0.001));
  const outdated = state.build && clientBuild !== 'dev' && clientBuild !== state.build;
  ui.diagnosticsSummary.textContent = `${clientBuild} · S${prediction.serverTick}${outdated ? ' · 请刷新' : ''}`;
  if (ui.diagnostics.open) {
    ui.diagnosticsData.textContent = [
      `客户端 ${clientBuild} / 服务器 ${state.build || '—'} / 实例 ${state.instance || '—'}`,
      `FPS ${diagnostic.fps} / 最长帧 ${diagnostic.maxFrame.toFixed(1)} ms`,
      `往返 ${Math.round(state.rtt)} ms / DPR ${renderer.getPixelRatio()}`,
      `服务器 S${prediction.serverTick} / 远车显示 V${state.viewTick || 0}`,
      `本地渲染 R${diagnostic.render} / 生命 ${prediction.epoch}`,
      `输入 I${prediction.seq} / 已确认 A${prediction.ack}`,
      `待确认 ${prediction.pending.length} / 校正 ${(prediction.lastCorrection * 100).toFixed(1)} cm`,
    ].join('\n');
  }
  diagnostic.frames = 0;
  diagnostic.seconds = 0;
  diagnostic.maxFrame = 0;
}

// ============================================================================
// 主循环
// ============================================================================
let lastFrame = performance.now();
function frame(t) {
  requestAnimationFrame(frame);
  const now = t / 1000;
  const rawDt = Math.max(0, (t - lastFrame) / 1000);
  const dt = Math.min(0.05, rawDt);
  lastFrame = t;
  if (state.soloActive) {
    if (!document.hidden) {
      predictionTime += Math.min(rawDt, 4 * STEP);
      while (predictionTime >= STEP) {
        for (const [id, c] of localGame.cars) prevLocalCars.set(id, { ...c });
        const myCar = localGame.cars.get(state.myId);
        const inp = myCar && myCar.state === 'alive' ? currentInput(myCar) : { th: 0, st: 0 };
        localGame.setInput(state.myId, inp.th, inp.st);
        localGame.step(STEP);
        for (const e of localGame.events.splice(0)) {
          onEvent(e);
          if (e[0] === 'fall' && e[2] === state.myId) {
            reportKnockout();
          }
        }
        for (const d of localGame.deaths.splice(0)) {
          if (d.id === state.myId) showDeath(d);
        }
        predictionTime -= STEP;
      }
    }
    syncLocalRoster();
    syncLocalView(predictionTime / STEP);
    syncCars(dt, now);
  } else {
    sampleView(now, rawDt);
    if (state.prediction && ws?.readyState === WebSocket.OPEN && !document.hidden) {
      prediction.syncPeers(state.view, state.myId);
      predictionTime += Math.min(rawDt, 4 * STEP);
      while (predictionTime >= STEP) {
        const me = prediction.car;
        prediction.step(me && me.state === 'alive' ? currentInput(me) : { th: 0, st: 0 });
        predictionTime -= STEP;
      }
      if (prediction.lastHitPeer) {
        const hp = prediction.lastHitPeer;
        prediction.lastHitPeer = null;
        const cur = peerKnockback.get(hp.id);
        if (cur) {
          cur.vx = hp.vx;
          cur.vz = hp.vz;
          cur.w = hp.w;
        }
      }
      const alpha = predictionTime / STEP;
      prediction.alpha = alpha;
      if (pendingSnapshots.length) {
        for (const s of pendingSnapshots.splice(0)) prediction.reconcile(s);
      }
      for (const event of prediction.contacts.splice(0)) onEvent(event);
      if (now - inputFlushAt >= 1 / 30 || prediction.unsent.length >= 4 || (prediction.hasImmediateChange() && now - inputFlushAt >= STEP)) {
        flushInputs();
        inputFlushAt = now;
      }
      const me = prediction.sample(alpha, rawDt);
      if (me) {
        state.view.set(state.myId, me);
      } else state.view.delete(state.myId);
    }
    if (state.snaps.length) syncCars(dt, now);
  }
  updateParticles(dt);
  for (const c of clouds) {
    c.position.x += c.userData.speed * dt;
    if (c.position.x > 520) c.position.x = -520;
  }
  updateCamera(rawDt, state.view.get(state.myId)); // 低帧率设备上镜头也要及时跟上
  sky.position.copy(camera.position);
  updateHud(now);
  renderer.render(scene, camera);
  adaptQuality(rawDt);
  updateDiagnostics(now, rawDt);
}
requestAnimationFrame(frame);
const featured = new Set(FEATURED_COUNTRIES);
for (const [label, codes] of [
  ['常见国家', FEATURED_COUNTRIES],
  ['其他国家和地区', COUNTRY_CODES.filter((code) => !featured.has(code)).sort((a, b) => countryName(a).localeCompare(countryName(b), 'zh-CN'))],
]) {
  const group = document.createElement('optgroup');
  group.label = label;
  for (const code of codes) {
    const option = document.createElement('option');
    option.value = code;
    option.textContent = `${countryFlag(code)} ${countryName(code)}`;
    group.append(option);
  }
  ui.countrySelect.append(group);
}
ui.countrySelect.value = COUNTRY_CODES.includes(storageGet('rb-country')) ? storageGet('rb-country') : 'CN';
ui.joinName.value = state.myName;
ui.joinButton.addEventListener('click', () => {
  state.country = ui.countrySelect.value;
  state.myName = ui.joinName.value.trim();
  storageSet('rb-name', state.myName);
  storageSet('rb-country', state.country);
  ui.join.hidden = true;
  startPromotions($('promotion'));
  startLocalGame();
  connect();
});

// 调试/测试用：只读的状态快照
window.__rooftop = { state, carViews, renderer, scene, camera, prediction, localGame };
