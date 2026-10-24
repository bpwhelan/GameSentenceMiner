const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hitTestMagpiePointer } = require('../magpie_hit_test');

for (const origin of [{ x: 2560, y: 164 }, { x: -1920, y: -1080 }]) {
  test(`native pointer hit test respects physical origin ${origin.x}, ${origin.y} and mixed DPI`, () => {
    const display = { physicalBounds: origin, physicalSize: { width: 1920, height: 1080 } };
    const viewport = { innerWidth: 960, innerHeight: 540 };
    let point;
    const document = { elementFromPoint(x, y) { point = { x, y }; return { closest: () => ({}) }; } };
    assert.equal(hitTestMagpiePointer({ x: origin.x + 960, y: origin.y + 540 }, display, viewport, document), true);
    assert.deepEqual(point, { x: 480, y: 270 });
    assert.equal(hitTestMagpiePointer({ x: origin.x - 1, y: origin.y }, display, viewport, document), false);
    assert.equal(hitTestMagpiePointer({ x: origin.x + 1920, y: origin.y }, display, viewport, document), false);
  });
}

test('blank space and an unavailable display never capture input', () => {
  const viewport = { innerWidth: 100, innerHeight: 100 };
  const display = { physicalBounds: { x: 0, y: 0 }, physicalSize: { width: 100, height: 100 } };
  assert.equal(hitTestMagpiePointer({ x: 10, y: 10 }, display, viewport, { elementFromPoint: () => null }), false);
  assert.equal(hitTestMagpiePointer({ x: 10, y: 10 }, null, viewport, {}), false);
});
