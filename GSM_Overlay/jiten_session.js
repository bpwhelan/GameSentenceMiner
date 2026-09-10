/** Route Jiten Reader requests through the overlay broker, in its own session. */

// These are JSON endpoints used by the bundled Reader. Other traffic (including
// dictionary downloads/PDFs) retains Chromium's normal streaming behavior.
const ACTIONS = new Set([
  'reader/parse', 'reader/lookup-vocabulary', 'reader/ping',
  'srs/reader-study-decks', 'srs/review', 'srs/set-vocabulary-state',
  'srs/add-vocabulary', 'srs/remove-vocabulary',
  'srs/batch-review', 'set-card-sentence',
]);

function installJitenSessionBroker(overlaySession, broker) {
  const upstreamFetch = (input, init = {}) => overlaySession.fetch(input, { ...init, bypassCustomProtocolHandlers: true });
  const handle = async (request) => {
    const url = new URL(request.url);
    const match = url.pathname.match(/^(.*\/)(reader\/[^/]+|srs\/[^/]+|srs\/study-decks\/\d+\/words|set-card-sentence)\/?$/);
    const action = match?.[2];
    const supported = ACTIONS.has(action) || /^srs\/study-decks\/\d+\/words$/.test(action);
    // Recognize the Reader's ApiKey authentication on custom API bases too.
    // Forward to exactly the requested host; never substitute the public host.
    const readerAuth = /^ApiKey\s+/i.test(request.headers.get('authorization') || '');
    if (!supported || (url.origin !== 'https://api.jiten.moe' && !readerAuth)) return upstreamFetch(request);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: {
        'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Api-Key, Accept, X-GSM-Request-Id',
      } });
    }
    if (!['POST', 'GET'].includes(request.method)) return upstreamFetch(request);
    try {
      if (url.search) throw Object.assign(new Error('Unsupported Jiten query parameters'), { statusCode: 400 });
      const apiKey = request.headers.get('x-api-key') || request.headers.get('authorization')?.replace(/^ApiKey\s+/i, '') || '';
      let body;
      if (request.method === 'POST' && request.body) {
        const reader = request.body.getReader();
        const chunks = [];
        let bytes = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.length;
          if (bytes > 1024 * 1024) {
            await reader.cancel();
            throw Object.assign(new Error('Jiten request body too large'), { statusCode: 413 });
          }
          chunks.push(Buffer.from(value));
        }
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw) {
          try { body = JSON.parse(raw); }
          catch { throw Object.assign(new Error('Invalid Jiten JSON request'), { statusCode: 400 }); }
        }
      }
      const endpoint = `${url.origin}${match[1]}reader/parse`;
      const result = await broker.request({ action, body, method: request.method, apiKey, endpoint, signal: request.signal, requestId: request.headers.get('x-gsm-request-id') });
      return Response.json(result, { headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
    } catch (err) {
      const headers = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' };
      if (Number.isFinite(err.retryAfterMs) && err.retryAfterMs > 0) headers['Retry-After'] = String(Math.ceil(err.retryAfterMs / 1000));
      // Never expose an upstream body, input text, or credentials to logs or
      // callers. Reader retries receive these local errors during cooldown.
      return Response.json({ error_message: `Jiten request unavailable (HTTP ${err.statusCode || 503})` }, { status: err.statusCode || 503, headers });
    }
  };
  overlaySession.protocol.handle('https', handle);
  try { overlaySession.protocol.handle('http', handle); }
  catch (err) { overlaySession.protocol.unhandle('https'); throw err; }
  return () => {
    overlaySession.protocol.unhandle('https');
    overlaySession.protocol.unhandle('http');
  };
}

// A newly submitted frame acquires its shared paragraphs before releasing the
// old frame, so overlap remains coalesced while obsolete queued text is dropped.
class JitenFrameRequests {
  constructor(broker) { this.broker = broker; this.frames = new Map(); }
  async parse(owner, args) {
    const previous = this.frames.get(owner);
    const controller = new AbortController();
    this.frames.set(owner, controller);
    const promise = this.broker.parseMany({ ...args, signal: controller.signal });
    previous?.abort();
    try { return await promise; }
    finally { if (this.frames.get(owner) === controller) this.frames.delete(owner); }
  }
  cancel(owner) { this.frames.get(owner)?.abort(); this.frames.delete(owner); }
  dispose() { for (const owner of this.frames.keys()) this.cancel(owner); }
}

module.exports = { installJitenSessionBroker, JitenFrameRequests };
