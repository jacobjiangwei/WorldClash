import { drive, collideCars, collideObstacles, levelStats, finishDrive, startFall, advanceFall, wrapAngle, WORLD } from './sim.js';

export const STEP = 1 / 60;
export const MAX_PENDING = 60;

// Commands represent fixed simulation steps, never client-supplied elapsed time.
export class InputQueue {
  constructor() {
    this.reset();
  }

  reset() {
    this.frames = [];
    this.received = 0;
    this.ack = 0;
    this.starved = 0;
    this.confirmed = null;
    this.stepped = false;
  }

  receive(from, frames) {
    if (!Number.isSafeInteger(from) || from < 1 || from + frames?.length > 0xffffffff ||
        !Array.isArray(frames) || frames.length < 1 || frames.length > 8 ||
        frames.some((f) => !Array.isArray(f) || f.length !== 2 ||
          f.some((v) => !Number.isFinite(v) || Math.abs(v) > 1))) return false;
    const fresh = frames.map(([th, st], i) => ({ seq: from + i, th, st })).filter((f) => f.seq > this.received);
    if (this.frames.length + fresh.length > MAX_PENDING) return false;
    this.frames.push(...fresh);
    if (fresh.length) this.received = fresh.at(-1).seq;
    return true;
  }

  take() {
    // Steering samples are not discrete actions: after a jitter burst, prefer
    // current intent to making the driver wait through obsolete steering, while
    // allowing starved ticks to catch up without dropping in-flight inputs.
    const keep = 3 + this.starved;
    if (this.frames.length > keep) this.frames.splice(0, this.frames.length - keep);
    const frame = this.frames.shift();
    if (frame) {
      this.ack = frame.seq;
      if (this.starved > 0) this.starved--;
    } else {
      this.starved = Math.min(24, this.starved + 1);
    }
    return frame;
  }

  beforeStep(game, id, dt) {
    this.stepped = false;
    const car = game.cars.get(id);
    if (!car || car.state !== 'alive') {
      this.confirmed = null;
      this.starved = 0;
      const frame = this.take();
      if (frame) game.setInput(id, frame.th, frame.st);
      return;
    }
    if (this.received === 0) {
      if (!this.confirmed) this.confirmed = { ...car };
      car._coasting = true;
      this.starved = 0;
      return;
    }
    if (this.frames.length > 0) {
      car._coasting = false;
      if ((this.starved > 0 || this.ack === 0) && this.confirmed) {
        Object.assign(car, this.confirmed);
        const catchUp = this.ack === 0 ? this.frames.length - 1 : Math.min(this.starved, this.frames.length - 1);
        for (let i = 0; i < catchUp && car.state === 'alive'; i++) {
          const f = this.frames.shift();
          this.ack = f.seq;
          if (this.starved > 0) this.starved--;
          game.setInput(id, f.th, f.st);
          car.th = f.th;
          car.st = f.st;
          drive(car, f, dt);
          collideObstacles(car);
          collideObstacles(car);
          if ((car._clientSynced || -99) > game.time - 0.75) {
            car.x = Math.max(-WORLD.hw + 0.05, Math.min(WORLD.hw - 0.05, car.x));
            car.z = Math.max(-WORLD.hd + 0.05, Math.min(WORLD.hd - 0.05, car.z));
          }
          if (finishDrive(car, dt)) game._startFall(car);
        }
      }
      if (car.state === 'alive') {
        const frame = this.take();
        if (frame) {
          game.setInput(id, frame.th, frame.st);
          this.stepped = true;
        }
      }
    } else {
      car._coasting = true;
      if (!this.confirmed) this.confirmed = { ...car };
      this.starved = Math.min(36, this.starved + 1);
      if (this.starved >= 36) this.confirmed = null;
    }
  }

  afterStep(car) {
    if (!car || car.state !== 'alive') {
      this.confirmed = null;
      this.starved = 0;
      return;
    }
    if (car._collided || (this.confirmed && this.confirmed.level !== car.level)) {
      this.confirmed = { ...car };
      this.starved = 0;
    } else if (this.stepped) {
      this.confirmed = { ...car };
    }
  }

  applySync(game, id, sync) {
    if (!sync || typeof sync !== 'object' || !Number.isSafeInteger(sync.seq) ||
        sync.seq < this.ack || sync.seq > this.received ||
        !Array.isArray(sync.car) || sync.car.length !== 7 ||
        sync.car.some((v) => !Number.isFinite(v))) return false;
    const car = game.cars.get(id);
    if (!car || car.state !== 'alive') return false;
    const [x, z, h, vx, vz, w, stun] = sync.car;
    if (Math.abs(x) > WORLD.hw + 3.5 || Math.abs(z) > WORLD.hd + 3.5 ||
        Math.hypot(vx, vz) > car.p.maxSpeed * 1.8 + 8 || Math.abs(w) > 25) return false;
    car._clientSynced = game.time;
    car._coasting = false;
    const p = game.players.get(id);
    if (p) p.inputAt = game.time;
    car.x = x;
    car.z = z;
    car.h = wrapAngle(h);
    car.vx = vx;
    car.vz = vz;
    car.w = w;
    car.stun = Math.max(0, Math.min(1.5, stun));
    this.frames = this.frames.filter((f) => f.seq > sync.seq);
    this.ack = Math.max(this.ack, sync.seq);
    this.starved = 0;
    this.confirmed = { ...car };
    if (finishDrive(car, 0)) game._startFall(car);

    if (car.protect <= 0 && Array.isArray(sync.peer) && sync.peer.length === 8 && sync.peer.every((v) => Number.isFinite(v))) {
      const [peerId, px, pz, pvx, pvz, pw, pstun, power] = sync.peer;
      const peer = game.cars.get(peerId);
      if (peer && peer.id !== car.id && peer.state === 'alive' && peer.protect <= 0 &&
          Math.hypot(x - peer.x, z - peer.z) <= 14 &&
          Math.hypot(pvx, pvz) <= peer.p.maxSpeed * 1.8 + 8 && Math.abs(pw) <= 25) {
        const pairKey = car.id < peer.id ? `${car.id}:${peer.id}` : `${peer.id}:${car.id}`;
        if ((game.pairCooldown.get(pairKey) || -99) <= game.time - 0.25) {
          game.pairCooldown.set(pairKey, game.time);
          if (Math.abs(px) <= WORLD.hw + 2 && Math.abs(pz) <= WORLD.hd + 2 && Math.hypot(px - peer.x, pz - peer.z) <= 6) {
            peer.x = px;
            peer.z = pz;
          }
          peer.vx = pvx;
          peer.vz = pvz;
          peer.w = pw;
          peer.stun = Math.max(peer.stun, Math.max(0, Math.min(1.5, pstun)));
          car.hitBy = peer.id;
          car.hitAt = game.time;
          peer.hitBy = car.id;
          peer.hitAt = game.time;
          if (power > 2.5) {
            game.events.push([
              'hit',
              Math.round((car.x + peer.x) * 50) / 100,
              Math.round((car.z + peer.z) * 50) / 100,
              Math.round(Math.min(30, power) * 100) / 100,
              car.id,
              peer.id,
            ]);
          }
        }
      }
    }
    return true;
  }

  release() {
    this.frames.length = 0;
    this.ack = this.received;
    this.starved = 0;
    this.confirmed = null;
    this.stepped = false;
  }
}

function physical(car) {
  const p = levelStats(car.level);
  return { ...car, p, m: p.mass, I: p.inertia, s: p.scale };
}

function view(car) {
  return { ...car, falling: car.state === 'falling', protect: car.protect > 0, stun: car.stun > 0 };
}

const AXES = { x: 'vx', z: 'vz', y: 'vy', h: 'w' };
const zeroError = () => ({ x: 0, z: 0, y: 0, h: 0 });
const r3 = (v) => Math.round(v * 1000) / 1000;
function displacement(car, previous, key) {
  const delta = car[key] - previous[key];
  return key === 'h' ? wrapAngle(delta) : delta;
}

export class Prediction {
  constructor({ leadTicks = 0 } = {}) {
    this.initialLead = leadTicks;
    this.reset();
  }

  reset() {
    this.leadTicks = this.initialLead;
    this.latestSnapshot = null;
    this.tick = 0;
    this.alpha = 1;
    this.confirmedInput = { th: 0, st: 0 };
    this.car = null;
    this.previous = null;
    this.pending = [];
    this.unsent = [];
    this.seq = 0;
    this.ack = 0;
    this.serverTick = 0;
    this.epoch = 0;
    this.peers = [];
    this.previousPeers = new Map();
    this.peerErrors = new Map();
    this.contacts = [];
    this.collisionLock = null;
    this.pendingSync = null;
    this.age = 0;
    this.error = zeroError();
    this.errorVelocity = zeroError();
    this.lastCorrection = 0;
  }

  synchronize(rtt) {
    if (this.leadTicks !== null) return;
    this.leadTicks = Math.min(MAX_PENDING - 8, Math.max(2, Math.ceil(rtt / 1000 / STEP) + 2));
    if (this.latestSnapshot) this.reconcile(this.latestSnapshot);
  }

  reconcile(snapshot) {
    if (!Object.hasOwn(snapshot, 'self')) return;
    this.latestSnapshot = snapshot;
    this.serverTick = snapshot.tick;
    if (this.leadTicks === null) return;
    this.ack = snapshot.ack;
    const self = snapshot.self;
    if (!self) {
      this.car = this.previous = null;
      this.peers = [];
      this.previousPeers.clear();
      this.peerErrors.clear();
      this.pending = [];
      this.unsent = [];
      this.collisionLock = null;
      this.pendingSync = null;
      return;
    }
    const fresh = self.epoch !== this.epoch || !this.car;
    const before = this.car;
    const oldPrevious = this.previous;
    const oldPeers = new Map(this.peers.map((c) => [c.id, c]));
    const oldPreviousPeers = this.previousPeers;
    if (fresh) {
      this.pending = [];
      this.unsent = [];
      this.seq = 0;
      this.epoch = self.epoch;
      this.tick = snapshot.tick + this.leadTicks;
      this.confirmedInput = { th: 0, st: 0 };
      this.collisionLock = null;
      this.pendingSync = null;
    } else {
      const confirmed = this.pending.findLast((f) => f.seq <= snapshot.ack);
      if (confirmed) this.confirmedInput = { th: confirmed.th, st: confirmed.st };
      this.pending = this.pending.filter((f) => f.seq > snapshot.ack);
      if (this.collisionLock && snapshot.ack >= this.collisionLock.seq) {
        this.collisionLock = null;
      }
      // Re-anchor after a suspended tab/server, not on every acknowledgment.
      if (this.tick < snapshot.tick || this.tick > snapshot.tick + MAX_PENDING) {
        this.tick = snapshot.tick + this.leadTicks;
        this.pending.forEach((f, i) => { f.tick = this.tick - this.pending.length + i + 1; });
      }
    }
    const locked = !fresh && this.collisionLock && self.state === 'alive' && snapshot.ack < this.collisionLock.seq;
    this.car = physical(locked ? { ...self, ...this.collisionLock.car, level: self.level, kos: self.kos } : self);
    this.previous = { ...this.car };
    for (const [key, velocity] of Object.entries(AXES)) this.previous[key] -= this.car[velocity] * STEP;
    this.peers = [...snapshot.cars.values()].filter((c) => c.id !== self.id && !c.falling).map((c) =>
      physical({
        ...c,
        state: 'alive',
        th: c.th ?? 0,
        st: c.st ?? 0,
        protect: c.protectTime ?? (c.protect ? 3 : 0),
        stun: c.stunTime ?? (c.stun ? 0.1 : 0),
      }));
    this.age = 0;
    this.previousPeers = new Map();
    const serverSteps = Math.round(((self.alive || 0) + (self.fallT || 0)) / STEP);
    const replay = locked
      ? this.pending.filter((f) => f.seq > this.collisionLock.seq)
      : (snapshot.ack === 0 && Math.hypot(self.vx, self.vz) > 1e-3 && this.pending.every((f) => f.th === 0 && f.st === 0)
        ? this.pending.slice(serverSteps)
        : this.pending);
    for (let i = 0; i < replay.length; i++) {
      this.advance(replay[i], false);
    }
    if (!fresh && snapshot.ack > 0 && before?.state === 'alive' && this.car.state === 'alive' &&
        Math.abs(before.x) <= WORLD.hw && Math.abs(before.z) <= WORLD.hd) {
      this.car.x = before.x;
      this.car.z = before.z;
      this.car.y = before.y;
      this.car.h = before.h;
      this.car.vx = before.vx;
      this.car.vz = before.vz;
      this.car.w = before.w;
      this.previous = oldPrevious ? { ...oldPrevious } : { ...this.car };
      if (!this.pendingSync) {
        this.pendingSync = {
          seq: this.seq,
          car: [this.car.x, this.car.z, this.car.h, this.car.vx, this.car.vz, this.car.w, this.car.stun],
        };
      }
    }
    const peerErrors = new Map();
    for (const peer of this.peers) {
      let prev = this.previousPeers.get(peer.id);
      if (!prev) {
        prev = { ...peer };
        for (const [key, velocity] of Object.entries(AXES)) prev[key] -= (peer[velocity] || 0) * STEP;
        this.previousPeers.set(peer.id, prev);
      }
      const old = oldPeers.get(peer.id);
      const oldPrev = oldPreviousPeers.get(peer.id) || old;
      const state = this.peerErrors.get(peer.id) || { x: 0, z: 0, h: 0, vx: 0, vz: 0, w: 0 };
      if (!fresh && old && Math.hypot(old.x - peer.x, old.z - peer.z) < 12) {
        for (const [key, velocity] of [['x', 'vx'], ['z', 'vz'], ['h', 'w']]) {
          const oldDelta = displacement(old, oldPrev, key);
          const newDelta = displacement(peer, prev, key);
          let correction = old[key] - peer[key] + (newDelta - oldDelta) * (1 - this.alpha);
          if (key === 'h') correction = wrapAngle(correction);
          state[key] += correction;
          if (key === 'h') state[key] = wrapAngle(state[key]);
          state[velocity] += (oldDelta - newDelta) / STEP;
        }
        peerErrors.set(peer.id, state);
      }
    }
    this.peerErrors = peerErrors;
    // Reconciliation changes physics immediately; only the presentation error decays.
    if (fresh) {
      this.previous = { ...this.car };
      this.error = zeroError();
      this.errorVelocity = zeroError();
      this.lastCorrection = 0;
    } else {
      this.lastCorrection = Math.hypot(before.x - this.car.x, before.z - this.car.z);
      if (this.lastCorrection > 12) {
        this.previous = { ...this.car };
        this.error = zeroError();
        this.errorVelocity = zeroError();
      } else {
        for (const key of Object.keys(AXES)) {
          const oldDelta = displacement(before, oldPrevious || before, key);
          const newDelta = displacement(this.car, this.previous, key);
          let correction = before[key] - this.car[key] + (newDelta - oldDelta) * (1 - this.alpha);
          if (key === 'h') correction = wrapAngle(correction);
          this.error[key] += correction;
          if (key === 'h') this.error[key] = wrapAngle(this.error[key]);
          this.errorVelocity[key] += (oldDelta - newDelta) / STEP;
        }
      }
    }
  }

  advance(input, feedback = false) {
    const car = this.car;
    this.previous = { ...car };
    if (feedback) this.age += STEP;
    if (car.state === 'falling') {
      advanceFall(car, STEP);
      return;
    }
    drive(car, input, STEP);
    if (feedback) {
      for (const peer of this.peers) {
        this.previousPeers.set(peer.id, { ...peer });
        drive(peer, { th: peer.th ?? 0, st: peer.st ?? 0 }, STEP);
      }
    }
    let hitPeer = null;
    let hitPower = 0;
    for (let pass = 0; pass < 2; pass++) {
      if (feedback && car.protect <= 0 && this.age <= 0.5) {
        for (const peer of this.peers) {
          if (peer.protect > 0) continue;
          const power = collideCars(car, peer, 0);
          if (power > 0) {
            hitPeer = peer;
            hitPower = Math.max(hitPower, power);
          }
          if (pass === 0 && power > 2.5) {
            this.contacts.push(['hit', (car.x + peer.x) / 2, (car.z + peer.z) / 2, power, car.id, peer.id]);
          }
        }
      }
      if (feedback) {
        for (let i = 0; i < this.peers.length; i++) {
          const a = this.peers[i];
          if (a.protect > 0) continue;
          for (let k = i + 1; k < this.peers.length; k++) {
            const b = this.peers[k];
            if (b.protect > 0) continue;
            collideCars(a, b, 0);
          }
        }
      }
      collideObstacles(car);
      if (feedback) {
        for (const peer of this.peers) collideObstacles(peer);
      }
    }
    if (feedback) {
      for (const peer of this.peers) finishDrive(peer, STEP);
    }
    const fell = finishDrive(car, STEP);
    if (fell) startFall(car);
    if (feedback && (hitPeer || fell)) {
      if (car.state === 'alive') this.collisionLock = { seq: this.seq, car: { ...car } };
      if (hitPeer) this.lastHitPeer = { id: hitPeer.id, vx: hitPeer.vx, vz: hitPeer.vz, w: hitPeer.w };
      this.pendingSync = {
        seq: this.seq,
        car: [r3(car.x), r3(car.z), r3(car.h), r3(car.vx), r3(car.vz), r3(car.w), r3(car.stun)],
        ...(hitPeer ? { peer: [hitPeer.id, r3(hitPeer.x), r3(hitPeer.z), r3(hitPeer.vx), r3(hitPeer.vz), r3(hitPeer.w), r3(hitPeer.stun), r3(hitPower)] } : {}),
      };
    }
  }

  step(input) {
    if (!this.car || this.leadTicks === null) return false;
    const frame = { seq: ++this.seq, tick: ++this.tick, th: input.th, st: input.st };
    this.pending.push(frame);
    this.unsent.push(frame);
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    if (this.unsent.length > MAX_PENDING) this.unsent.shift();
    this.advance(frame, true);
    return true;
  }

  hasImmediateChange() {
    if (this.pendingSync) return true;
    if (this.unsent.length < 1 || this.pending.length < 2) return false;
    const a = this.pending.at(-2);
    const b = this.pending.at(-1);
    return Math.abs(a.th - b.th) > 0.05 || Math.abs(a.st - b.st) > 0.05;
  }

  syncPeers(viewMap, myId) {
    if (!this.car) return;
    const next = [];
    for (const [id, c] of viewMap) {
      if (id === myId || c.falling) continue;
      next.push(physical({
        ...c,
        state: 'alive',
        th: c.th ?? 0,
        st: c.st ?? 0,
        protect: c.protect ? 0.5 : 0,
        stun: c.stun ? 0.1 : 0,
      }));
    }
    this.peers = next;
  }

  packet() {
    if (!this.unsent.length && !this.pendingSync) return null;
    const frames = this.unsent.splice(0, 8);
    const pkt = {
      t: 'inputs',
      epoch: this.epoch,
      from: frames.length ? frames[0].seq : this.seq,
      frames: frames.length ? frames.map((f) => [f.th, f.st]) : [[this.confirmedInput.th, this.confirmedInput.st]],
    };
    if (this.pendingSync) {
      pkt.sync = this.pendingSync;
      this.pendingSync = null;
    } else if (this.car && this.car.state === 'alive' && this.seq > 0) {
      pkt.sync = {
        seq: this.seq,
        car: [r3(this.car.x), r3(this.car.z), r3(this.car.h), r3(this.car.vx), r3(this.car.vz), r3(this.car.w), r3(this.car.stun)],
      };
    }
    return pkt;
  }

  release() {
    this.pending.length = 0;
    this.unsent.length = 0;
    this.confirmedInput = { th: 0, st: 0 };
    this.collisionLock = null;
    this.pendingSync = null;
  }

  sample(alpha, dt) {
    if (!this.car) return null;
    this.alpha = alpha;
    const decay = Math.exp(-dt * 12);
    for (const key of Object.keys(AXES)) {
      this.error[key] *= decay;
      this.errorVelocity[key] *= decay;
    }
    const car = view(this.car);
    const prev = this.previous || this.car;
    for (const [key, velocity] of Object.entries(AXES)) {
      const delta = displacement(this.car, prev, key);
      car[key] = prev[key] + delta * alpha + this.error[key];
      car[velocity] = delta / STEP + this.errorVelocity[key];
    }
    for (const key of ['pitch', 'roll']) car[key] = prev[key] + wrapAngle(car[key] - prev[key]) * alpha;
    return car;
  }

  samplePeers(alpha, dt) {
    if (!this.car || this.car.state !== 'alive' || this.age > 0.5) return [];
    const decay = Math.exp(-dt * 12);
    return this.peers.map((peer) => {
      const result = view(peer);
      const prev = this.previousPeers.get(peer.id) || peer;
      const err = this.peerErrors.get(peer.id);
      if (err) {
        for (const [key, velocity] of [['x', 'vx'], ['z', 'vz'], ['h', 'w']]) {
          err[key] *= decay;
          err[velocity] *= decay;
        }
      }
      for (const [key, velocity] of [['x', 'vx'], ['z', 'vz'], ['h', 'w']]) {
        const delta = displacement(peer, prev, key);
        result[key] = prev[key] + delta * alpha + (err?.[key] || 0);
        result[velocity] = delta / STEP + (err?.[velocity] || 0);
      }
      return result;
    });
  }
}
