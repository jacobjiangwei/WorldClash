import fs from 'node:fs';
import path from 'node:path';
import { countryCodes } from '../public/countries.js';

export function chinaDay(now = Date.now()) {
  return new Date(now + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function recordKnockout(scores, players, event) {
  if (event[0] !== 'fall' || !event[2]) return false;
  const victim = players.get(event[1]);
  const killer = players.get(event[2]);
  if (!victim || !killer || victim.isBot || killer.isBot) return false;
  scores.add(killer.country);
  return true;
}

export class Scores {
  constructor(file, now = Date.now) {
    this.file = file;
    this.now = now;
    this.day = chinaDay(now());
    this.scores = {};
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (saved.day === this.day && saved.scores && typeof saved.scores === 'object') {
        for (const [code, score] of Object.entries(saved.scores)) {
          if (countryCodes.has(code) && Number.isSafeInteger(score) && score >= 0) this.scores[code] = score;
        }
      }
    }
  }

  refresh() {
    const today = chinaDay(this.now());
    if (today === this.day) return false;
    this.day = today;
    this.scores = {};
    return true;
  }

  add(code) {
    if (!countryCodes.has(code)) throw new Error('Invalid country code');
    this.refresh();
    const next = { ...this.scores, [code]: (this.scores[code] || 0) + 1 };
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ day: this.day, scores: next }));
    fs.renameSync(temp, this.file);
    this.scores = next;
  }

  snapshot() {
    this.refresh();
    return { t: 'scores', day: this.day, scores: Object.entries(this.scores).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])) };
  }
}
