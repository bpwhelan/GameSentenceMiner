import assert from 'node:assert/strict';
import test from 'node:test';
import { miningSelectionChanges, selectMiningRange } from '../src/mining-selection.ts';

test('dragging selects an inclusive range and preserves other checked lines', () => {
	assert.deepEqual([...selectMiningRange(new Set(['outside']), ['a', 'b', 'c', 'd'], 'b', 'd', true)], ['outside', 'b', 'c', 'd']);
});

test('moving back toward the anchor shrinks the selection to the current gesture', () => {
	const initial = new Set(['d']);
	selectMiningRange(initial, ['a', 'b', 'c', 'd'], 'a', 'd', true);
	assert.deepEqual([...selectMiningRange(initial, ['a', 'b', 'c', 'd'], 'a', 'b', true)], ['d', 'a', 'b']);
	assert.deepEqual([...initial], ['d']);
});

test('reverse display order and dragging upward both use the visible range', () => {
	assert.deepEqual([...selectMiningRange(new Set(), ['d', 'c', 'b', 'a'], 'b', 'd', true)], ['d', 'c', 'b']);
});

test('dragging from a selected line clears that range only', () => {
	assert.deepEqual([...selectMiningRange(new Set(['a', 'b', 'c', 'outside']), ['a', 'b', 'c'], 'c', 'b', false)], ['a', 'outside']);
});

test('missing endpoints do not change the selection', () => {
	assert.deepEqual([...selectMiningRange(new Set(['a']), ['a', 'b'], 'a', 'expired', true)], ['a']);
});

test('commits contain explicit changes so retrying cannot toggle a line twice', () => {
	assert.deepEqual(miningSelectionChanges(new Set(['a', 'c']), new Set(['b', 'c'])), [{ id: 'a', checked: false }, { id: 'b', checked: true }]);
	assert.deepEqual(miningSelectionChanges(new Set(['a']), new Set(['a'])), []);
});
