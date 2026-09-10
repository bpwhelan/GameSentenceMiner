const { test } = require('node:test');
const assert = require('node:assert/strict');
const { JitenParseCache, DEFAULT_JITEN_PARSE_URL } = require('../jiten_cache');
const { installJitenSessionBroker, JitenFrameRequests } = require('../jiten_session');

function setup(t, respond) {
  const calls = [];
  const broker = new JitenParseCache({ batchDelayMs: 5, minIntervalMs: 0, parseIntervalMs: 0,
    fetch: async (url, init) => {
      const body = init.body ? JSON.parse(init.body) : {};
      calls.push({ url, body, headers: init.headers });
      return respond ? respond(url, body) : Response.json({ tokens: body.text.map(() => []), vocabulary: [] });
    },
  });
  let handler;
  const passed = [];
  const session = {
    protocol: { handle: (scheme, callback) => { assert.ok(['https', 'http'].includes(scheme)); handler = callback; }, unhandle: () => { handler = null; } },
    fetch: async (input, init) => { passed.push({ input, init }); return new Response('passthrough'); },
  };
  const uninstall = installJitenSessionBroker(session, broker);
  t.after(() => { uninstall(); broker.dispose(); });
  const request = (body, headers = { Authorization: 'ApiKey test' }, url = DEFAULT_JITEN_PARSE_URL) =>
    handler(new Request(url, { method: 'POST', headers, body: typeof body === 'string' ? body : JSON.stringify(body) }));
  return { broker, request, calls, passed, handler: (req) => handler(req) };
}

test('Reader Authorization and renderer X-Api-Key share one batched request', async (t) => {
  const { broker, request, calls } = setup(t);
  const [reader, renderer] = await Promise.all([
    request({ text: ['猫', '犬', '猫'] }),
    broker.parse({ apiKey: 'test', text: '猫' }),
  ]);
  assert.equal(reader.status, 200);
  assert.equal((await reader.json()).tokens.length, 3);
  assert.equal(renderer.tokens.length, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.text, ['猫', '犬']);
});

test('authenticated custom Reader endpoints retain their origin and API base', async (t) => {
  const { request, calls, passed } = setup(t);
  for (const endpoint of ['https://custom.test/jiten/api/reader/parse', 'http://localhost:9182/api/reader/parse']) {
    const response = await request({ text: ['猫'] }, { Authorization: 'ApiKey test' }, endpoint);
    assert.equal(response.status, 200);
    assert.equal(calls.at(-1).url, endpoint);
  }
  assert.equal(passed.length, 0);
});

test('Reader retries during 429 are answered locally with status and Retry-After', async (t) => {
  const { request, calls } = setup(t, () => new Response('Too many requests', { status: 429, headers: { 'Retry-After': '120' } }));
  for (let i = 0; i < 3; i++) {
    const result = await request({ text: [`猫${i}`] });
    assert.equal(result.status, 429);
    assert.ok(Number(result.headers.get('Retry-After')) >= 119);
    assert.ok((await result.json()).error_message);
  }
  assert.equal(calls.length, 1);
});

test('invalid JSON, schema, and oversized payloads do not reach upstream', async (t) => {
  const { request, calls } = setup(t);
  assert.equal((await request('{')).status, 400);
  assert.equal((await request({ text: [123] })).status, 400);
  assert.equal((await request({ text: ['猫'.repeat(16001)] })).status, 413);
  assert.equal((await request(' '.repeat(1024 * 1024 + 1))).status, 413);
  assert.equal(calls.length, 0);
});

test('unrelated HTTPS uses the same session with protocol bypass and preserved request', async (t) => {
  const { handler, passed, calls } = setup(t);
  const input = new Request('https://example.test/file', { method: 'POST', body: 'original' });
  assert.equal(await (await handler(input)).text(), 'passthrough');
  assert.equal(passed[0].input, input);
  assert.equal(passed[0].init.bypassCustomProtocolHandlers, true);
  assert.equal(calls.length, 0);
});

test('frame replacement removes obsolete queued text but keeps overlapping paragraphs', async (t) => {
  const { broker, calls } = setup(t);
  const frames = new JitenFrameRequests(broker);
  t.after(() => frames.dispose());
  const old = frames.parse(10, { apiKey: 'test', texts: ['古い', '共有'] });
  const rejected = assert.rejects(old, { name: 'AbortError' });
  const latest = frames.parse(10, { apiKey: 'test', texts: ['共有', '新しい'] });
  await Promise.all([rejected, latest]);
  assert.deepEqual(calls[0].body.text, ['共有', '新しい']);
  assert.equal(frames.frames.size, 0);
});

test('explicit frame cancellation and renderer separation', async (t) => {
  const { broker, calls } = setup(t);
  const frames = new JitenFrameRequests(broker);
  const first = frames.parse(1, { apiKey: 'test', texts: ['古い'] });
  const rejected = assert.rejects(first, { name: 'AbortError' });
  const second = frames.parse(2, { apiKey: 'test', texts: ['新しい'] });
  frames.cancel(1);
  await Promise.all([rejected, second]);
  assert.deepEqual(calls[0].body.text, ['新しい']);
});
