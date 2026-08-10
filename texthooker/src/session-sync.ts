import type { LineItem, TextFeedSessionSync } from './types';

export const DEFAULT_TEXTFEED_SESSION_SYNC_LINE_LIMIT = 1000;
export const TEXTFEED_SESSION_SYNC_BATCH_SIZE = 50;

export interface TextFeedSessionSyncPlan {
	syncedLines: LineItem[];
	retainedLines: LineItem[];
	insertionIndex: number;
}

export function getTextFeedSessionSyncLineLimit(maxLines: number) {
	if (!Number.isFinite(maxLines) || maxLines <= 0) {
		return DEFAULT_TEXTFEED_SESSION_SYNC_LINE_LIMIT;
	}

	return Math.min(Math.floor(maxLines), DEFAULT_TEXTFEED_SESSION_SYNC_LINE_LIMIT);
}

export function buildTextFeedSessionSyncPlan(
	sync: TextFeedSessionSync,
	existingLineData: LineItem[],
	normalizeLineContent: (text: string) => string | undefined,
): TextFeedSessionSyncPlan {
	const activeIds = new Set(sync.activeIds);
	const timedOutIds = new Set(sync.timedOutIds);
	const restoredIds = new Set(sync.orderedIds);
	const requestedIds = new Set(sync.requestedIds);
	const existingLines = new Map(existingLineData.map((line) => [line.id, line]));
	const missingLines = new Map(sync.missingLines.map((line) => [line.id, line]));
	const syncedLines: LineItem[] = [];

	for (const id of sync.orderedIds) {
		const existingLine = existingLines.get(id);
		const missingLine = missingLines.get(id);
		const gsmStatus = activeIds.has(id) ? 'active' : timedOutIds.has(id) ? 'timed_out' : 'active';
		if (existingLine) {
			const updatedText = missingLine ? normalizeLineContent(missingLine.text) : undefined;
			syncedLines.push({
				...existingLine,
				...(updatedText ? { text: updatedText } : {}),
				gsmSessionId: sync.sessionId,
				gsmStatus,
				streamSequence: missingLine?.streamSequence ?? existingLine.streamSequence,
				revision: missingLine?.revision ?? existingLine.revision,
				recordState: missingLine?.recordState ?? existingLine.recordState,
			});
			continue;
		}

		if (!missingLine) {
			continue;
		}
		const text = normalizeLineContent(missingLine.text);
		if (text) {
			syncedLines.push({
				id,
				text,
				excludedFromStats: missingLine.excludedFromStats,
				gsmSessionId: sync.sessionId,
				gsmStatus,
				sessionBackfill: true,
				streamSequence: missingLine.streamSequence,
				revision: missingLine.revision,
				recordState: missingLine.recordState,
			});
		}
	}

	let insertionIndex = -1;
	const retainedLines: LineItem[] = [];
	for (const line of existingLineData) {
		const belongsToRequestedSnapshot =
			restoredIds.has(line.id) || (line.gsmSessionId === sync.sessionId && requestedIds.has(line.id));
		const isCurrentSessionLine = line.gsmSessionId === sync.sessionId;

		if (belongsToRequestedSnapshot) {
			if (insertionIndex < 0) {
				insertionIndex = retainedLines.length;
			}
			continue;
		}

		if (isCurrentSessionLine && insertionIndex < 0) {
			// This line arrived after the sync request. Restored history belongs before it.
			insertionIndex = retainedLines.length;
		}
		retainedLines.push(line);
	}

	if (insertionIndex < 0) {
		insertionIndex = retainedLines.length;
	}

	return { syncedLines, retainedLines, insertionIndex };
}
