import assert from 'node:assert/strict';
import test from 'node:test';

import { buildGSMWebSocketFallbackUrl } from '../src/gsm.ts';

test('GSM websocket fallback keeps the route but switches to the reported direct port', () => {
	assert.equal(
		buildGSMWebSocketFallbackUrl('ws://127.0.0.1:7275/ws/texthooker', { direct_port: 8383 }),
		'ws://127.0.0.1:8383/ws/texthooker',
	);
});

test('GSM websocket fallback ignores an invalid or unchanged direct port', () => {
	assert.equal(
		buildGSMWebSocketFallbackUrl('ws://127.0.0.1:7275/ws/texthooker', { direct_port: 7275 }),
		null,
	);
	assert.equal(
		buildGSMWebSocketFallbackUrl('ws://127.0.0.1:7275/ws/texthooker', { direct_port: 'nope' }),
		null,
	);
});
