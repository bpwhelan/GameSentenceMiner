import type { LineItem, TextFeedSessionSync } from './types';

export const DEFAULT_TEXTFEED_SESSION_SYNC_LINE_LIMIT = 1000;
export const TEXTFEED_SESSION_SYNC_BATCH_SIZE = 50;

export interface TextFeedSessionSyncPlan {
	syncedLines: LineItem[];
	retainedLines: LineItem[];
	insertionIndex: number;
}

export interface TextFeedSessionSyncBatch {
	batchLines: LineItem[];
	remainingLines: LineItem[];
}

function getRevision(line: LineItem) {
	const revision = Number(line.revision ?? 0);
	return Number.isFinite(revision) ? revision : 0;
}

function selectLatestLine(existingLine: LineItem, candidateLine: LineItem) {
	return getRevision(candidateLine) >= getRevision(existingLine) ? candidateLine : existingLine;
}

export function deduplicateLineData(lines: LineItem[]) {
	const deduplicatedLines: LineItem[] = [];
	const indexesById = new Map<string, number>();
	let foundDuplicate = false;

	for (const line of lines) {
		const existingIndex = indexesById.get(line.id);
		if (existingIndex === undefined) {
			indexesById.set(line.id, deduplicatedLines.length);
			deduplicatedLines.push(line);
			continue;
		}

		foundDuplicate = true;
		deduplicatedLines[existingIndex] = selectLatestLine(deduplicatedLines[existingIndex], line);
	}

	return foundDuplicate ? deduplicatedLines : lines;
}

export function reconcileTextFeedSessionSyncBatch(
	snapshotBatch: LineItem[],
	currentLineData: LineItem[],
): TextFeedSessionSyncBatch {
	const batchIds = new Set(snapshotBatch.map((line) => line.id));
	const currentBatchLines = new Map<string, LineItem>();
	const remainingLines: LineItem[] = [];

	for (const line of deduplicateLineData(currentLineData)) {
		if (batchIds.has(line.id)) {
			const existingLine = currentBatchLines.get(line.id);
			currentBatchLines.set(line.id, existingLine ? selectLatestLine(existingLine, line) : line);
		} else {
			remainingLines.push(line);
		}
	}

	const batchLines = deduplicateLineData(
		snapshotBatch.map((line) => {
			const currentLine = currentBatchLines.get(line.id);
			return currentLine ? selectLatestLine(line, currentLine) : line;
		}),
	);
	return { batchLines, remainingLines };
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
	removedIds: ReadonlySet<string> = new Set(),
): TextFeedSessionSyncPlan {
	existingLineData = deduplicateLineData(existingLineData);
	const activeIds = new Set(sync.activeIds);
	const timedOutIds = new Set(sync.timedOutIds);
	const restoredIds = new Set(sync.orderedIds);
	const requestedIds = new Set(sync.requestedIds);
	const existingLines = new Map(existingLineData.map((line) => [line.id, line]));
	const missingLines = new Map(sync.missingLines.map((line) => [line.id, line]));
	const syncedLines: LineItem[] = [];

	for (const id of new Set(sync.orderedIds)) {
		if (removedIds.has(id)) {
			continue;
		}

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
