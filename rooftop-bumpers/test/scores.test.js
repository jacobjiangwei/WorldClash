import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Scores, chinaDay, recordKnockout } from '../src/scores.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rooftop-scores-'));
const file = path.join(dir, 'scores.json');
let now = Date.parse('2026-01-01T15:59:59Z');
try {
  const scores = new Scores(file, () => now);
  const players = new Map([
    [1, { country: 'CN', isBot: false }],
    [2, { country: 'US', isBot: false }],
    [3, { isBot: true }],
  ]);
  assert.equal(chinaDay(now), '2026-01-01');
  assert.equal(recordKnockout(scores, players, ['fall', 2, 1]), true);
  assert.equal(recordKnockout(scores, players, ['fall', 3, 1]), false);
  assert.equal(recordKnockout(scores, players, ['fall', 2, 3]), false);
  assert.equal(recordKnockout(scores, players, ['fall', 2, 0]), false);
  assert.deepEqual(new Scores(file, () => now).snapshot().scores, [['CN', 1]]);
  now += 1000;
  assert.equal(chinaDay(now), '2026-01-02');
  assert.deepEqual(scores.snapshot().scores, []);
  scores.add('US');
  assert.deepEqual(new Scores(file, () => now).snapshot().scores, [['US', 1]]);
  assert.throws(() => scores.add('XX'), /Invalid country/);
  console.log('国家积分、持久化和北京时间清零通过 ✅');
} finally {
  if (fs.existsSync(file)) fs.unlinkSync(file);
  fs.rmdirSync(dir);
}
