import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const bundledTextFeedUrl = new URL('../docs/index.html', import.meta.url);
const servedTextFeedUrl = new URL('../../GameSentenceMiner/web/templates/index.html', import.meta.url);

test('the bundled and served TextFeed understand authoritative v2 frames', async () => {
	const [bundled, served] = await Promise.all([
		readFile(bundledTextFeedUrl, 'utf8'),
		readFile(servedTextFeedUrl, 'utf8'),
	]);

	for (const artifact of [bundled, served]) {
		assert.match(artifact, /text_v2_snapshot_request/);
		assert.match(artifact, /text_v2_append/);
		assert.match(artifact, /text_v2_freeze/);
	}
	assert.equal(served, bundled);
});
