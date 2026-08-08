import assert from 'node:assert/strict';
import test from 'node:test';

import { shouldAutoScroll } from '../src/util.ts';

test('modern scrolling follows only when the reader is already at the newest line', () => {
	assert.equal(shouldAutoScroll(false, true), true);
	assert.equal(shouldAutoScroll(false, false), false);
});

test('always-scroll mode follows new content regardless of the current position', () => {
	assert.equal(shouldAutoScroll(true, true), true);
	assert.equal(shouldAutoScroll(true, false), true);
});
