const { test } = require('node:test');
const assert = require('node:assert/strict');
const { magpiePointerToViewport } = require('../magpie_hit_test');

for (const origin of [{ x: 2560, y: 164 }, { x: -1920, y: -1080 }]) {
  test(`native pointer hit test respects physical origin ${origin.x}, ${origin.y} and mixed DPI`, () => {
    const display = { physicalBounds: origin, physicalSize: { width: 1920, height: 1080 } };
    const viewport = { innerWidth: 960, innerHeight: 540 };
    assert.deepEqual(magpiePointerToViewport({ x: origin.x + 960, y: origin.y + 540, shiftKey: true }, display, viewport),
      { x: 480, y: 270, shiftKey: true });
    assert.equal(magpiePointerToViewport({ x: origin.x - 1, y: origin.y }, display, viewport), null);
    assert.equal(magpiePointerToViewport({ x: origin.x + 1920, y: origin.y }, display, viewport), null);
  });
}

test('an unavailable display or an invalid pointer cannot produce a hover point', () => {
  const viewport = { innerWidth: 100, innerHeight: 100 };
  const display = { physicalBounds: { x: 0, y: 0 }, physicalSize: { width: 100, height: 100 } };
  assert.equal(magpiePointerToViewport({ x: -Infinity, y: 10 }, display, viewport), null);
  assert.equal(magpiePointerToViewport({ x: 10, y: 10 }, null, viewport), null);
});
