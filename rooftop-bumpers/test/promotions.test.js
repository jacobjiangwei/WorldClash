import assert from 'node:assert/strict';
import { PROMOTIONS, nextPromotionIndex } from '../public/promotions.js';

assert.equal(PROMOTIONS.length, 3);
for (const promotion of PROMOTIONS) {
  const url = new URL(promotion.url);
  assert.equal(url.protocol, 'https:');
  assert.equal(url.hostname, 'apps.apple.com');
  assert.match(url.pathname, /^\/app\/id\d+$/);
}
assert.equal(nextPromotionIndex(3, -1, () => 0), 0);
for (let previous = -1; previous < PROMOTIONS.length; previous++) {
  for (const random of [0, 0.49, 0.99]) {
    const index = nextPromotionIndex(PROMOTIONS.length, previous, () => random);
    assert.ok(index >= 0 && index < PROMOTIONS.length);
    assert.notEqual(index, previous);
  }
}
console.log('推广链接和随机轮换通过 ✅');
