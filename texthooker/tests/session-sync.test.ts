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

test('v2 snapshot applies newer revisions and preserves legitimate repeated records', () => {
	const existingLines: LineItem[] = [
		{ id: 'one', text: 'draft', gsmSessionId: 'current', gsmStatus: 'active', revision: 1 },
	];
	const sync: TextFeedSessionSync = {
		sessionId: 'current',
		orderedIds: ['one', 'two'],
		activeIds: ['one', 'two'],
		timedOutIds: [],
		missingLines: [
			{
				id: 'one',
				text: 'same final text',
				excludedFromStats: false,
				streamSequence: 1,
				revision: 3,
				recordState: 'frozen',
			},
			{
				id: 'two',
				text: 'same final text',
				excludedFromStats: false,
				streamSequence: 2,
				revision: 2,
				recordState: 'frozen',
			},
		],
		requestedIds: ['one'],
	};

	const plan = buildTextFeedSessionSyncPlan(sync, existingLines, (text) => text);

	assert.deepEqual(
		plan.syncedLines.map((line) => [line.id, line.text, line.streamSequence, line.revision]),
		[
			['one', 'same final text', 1, 3],
			['two', 'same final text', 2, 2],
		],
	);
});
