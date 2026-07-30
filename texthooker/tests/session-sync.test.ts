import assert from 'node:assert/strict';
import test from 'node:test';

import { buildTextFeedSessionSyncPlan } from '../src/session-sync.ts';
import type { LineItem, TextFeedSessionSync } from '../src/types.ts';

test('bounded sync drops requested stale lines but preserves lines received after the request', () => {
	const existingLines: LineItem[] = [
		{ id: 'previous', text: 'previous', gsmSessionId: 'old', gsmStatus: 'previous_session' },
		{ id: 'stale', text: 'stale', gsmSessionId: 'current', gsmStatus: 'active' },
		{ id: 'kept', text: 'old text', gsmSessionId: 'current', gsmStatus: 'active' },
		{ id: 'live', text: 'live', gsmSessionId: 'current', gsmStatus: 'active' },
		{ id: 'external', text: 'external', gsmStatus: 'external' },
	];
	const sync: TextFeedSessionSync = {
		sessionId: 'current',
		orderedIds: ['kept', 'missing'],
		activeIds: ['kept', 'missing'],
		timedOutIds: [],
		missingLines: [{ id: 'missing', text: 'new text', excludedFromStats: false }],
		requestedIds: ['stale', 'kept'],
	};

	const plan = buildTextFeedSessionSyncPlan(sync, existingLines, (text) => text);

	assert.deepEqual(
		plan.syncedLines.map((line) => line.id),
		['kept', 'missing'],
	);
	assert.deepEqual(
		plan.retainedLines.map((line) => line.id),
		['previous', 'live', 'external'],
	);
	assert.equal(plan.insertionIndex, 1);
	assert.equal(plan.syncedLines[0].text, 'old text');
	assert.equal(plan.syncedLines[1].sessionBackfill, true);
});
