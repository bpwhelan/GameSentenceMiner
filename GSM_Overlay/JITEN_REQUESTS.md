# Jiten requests from the overlay

`jiten_cache.js` owns the network queue and caches. `main.js` creates one broker
for the overlay session. Renderer IPC, gamepad tokenization, furigana, grading,
and the bundled Reader's JSON API requests all share it. `jiten_session.js`
intercepts the Reader's requests before loading the extension, including requests
from its service worker. Reader requests using `Authorization: ApiKey` also work
with custom HTTP/HTTPS origins and API base paths; their destination is preserved.
Recognized JSON actions with query parameters fail locally rather than bypassing
the queue. Other HTTP/HTTPS traffic is forwarded through the same
Chromium session with protocol interception bypassed.

Reader traffic is intercepted in Electron, then the broker uses one bounded
keep-alive Node HTTP/HTTPS connection for its upstream lane. This avoids a
native Chromium HTTPS failure seen in the standalone overlay while keeping all
request coalescing, cache, and rate controls in one place. There is no local
HTTP proxy, direct renderer fetch fallback, or automatic upstream retry in the
broker.

## Request policy

| Control | Default |
| --- | --- |
| OCR settling delay | 250 ms; repeated identical text does not restart the delay |
| Backend batch collection | 120 ms |
| Upstream concurrency | 1 across parsing, state lookups, metadata, and grading |
| Minimum request spacing | 1 second |
| Minimum parse spacing | 2 seconds (at most 30 parse requests/minute) |
| Rolling parse budget | 60,000 charged characters/minute, minimum charge 2,000 per call |
| One parse batch | At most 128 paragraphs and 16,000 UTF-16 code units |
| Pending work | At most 512 items and 256,000 text code units |
| Syntax cache | 24 hours, LRU, at most 2,000 paragraphs or 16 MiB |
| Word state freshness | 5 minutes; refresh with `reader/lookup-vocabulary` |
| Reader study-deck list | 5 minutes; concurrent identical reads coalesce |
| Reader ping | 1 minute |
| Network deadline | 30 seconds, starting when sent, excluding queue time |

These are conservative GSM limits, not a claim about the service's quota. Short
legacy renderer timeout arguments do not override the shared transport deadline.
Frame cancellation removes unsent work without aborting a shared upstream parse.

Only uncached Japanese paragraphs are sent, as a real `text: string[]` batch.
Repeated paragraphs, overlapping concurrent requests, and partial cache hits do
not resubmit the same text. Empty results are cached. English with curly quotes,
em dashes, accents, or fullwidth Latin characters is filtered locally. Han script
is included because it is shared with Japanese; this is script detection, not
automatic language identification.

Text is never fuzzily matched, normalized, truncated, or concatenated before
parsing. Such changes can alter meaning and break the offsets used for readings
and highlighting. Oversized individual paragraphs fail locally; larger groups
of admissible paragraphs are split into bounded batches.

New furigana frames replace obsolete queued work, while shared paragraphs retain
their existing request. Work already sent can finish and populate the cache even
after a frame becomes obsolete. The renderer discards obsolete results, and an
unchanged frame reuses pending/completed readings without additional IPC. Reader
highlighting keeps one active parse and only the newest waiting frame. Visible
OCR text remains immediate; enrichment can wait under load.

## Failures and account state

429 responses pause the account/endpoint context for at least 60 seconds and
honor longer `Retry-After` values, including HTTP dates. Transport, server, and
malformed-response failures back off from 15 seconds to 5 minutes. 401/403 latch
the rejected credential until the key changes or the overlay restarts. Subsequent
Reader retries during a cooldown receive a local error; they do not hit Jiten.
Only a later consumer request can try again after the cooldown; no retry timer
sends work automatically.

Cache keys include the exact endpoint and a credential fingerprint. Account
states cannot cross API keys. Parse syntax stays cached after grading; affected
states and deck metadata are invalidated so the next lookup gets authoritative
state. Fresh parse responses populate the state cache themselves: the subsequent
lookup is local, so a new paragraph normally needs only one upstream request.
Each Reader operation carries an `X-GSM-Request-Id`, reused across its retries and
removed before forwarding upstream. The broker retains up to 512 write receipts
(maximum 64 KiB per response) for five minutes after completion. Retries with the
same ID reuse the pending operation, result, or error; separate clicks have separate
IDs. Reusing an ID with different content fails locally. This is needed because
Chromium does not reliably propagate renderer aborts through protocol handlers.
If a caller without an ID
aborts a write after dispatch, identical writes are rejected locally with HTTP 409
for two minutes because the original may have succeeded. This also suppresses
Reader timeout retries, at the cost of temporarily rejecting an intentional
identical grade. Refresh state before trying again.
If refreshing cached word states fails, readings remain usable with the last
available state. Changes made outside GSM may take up to the freshness interval
to appear when the text is next requested.
State refresh failures use the same account cooldown as parse failures; this is
deliberate backpressure during service trouble. Cached syntax remains usable.

Caches exist only in memory and are cleared on overlay shutdown. No API key,
OCR text, or response body is written to disk or diagnostic output by the broker.
Shutdown cancels queued work and removes both session handlers. The handlers are
installed before extension loading and fail startup if their protocol registration
fails. Reader TTS audio, PDFs, dictionary downloads, and GSM's separate Python media
metadata client retain their existing transport; they are not OCR parsing traffic.

## Diagnostics and tests

The `gsm-jiten-request-stats` IPC handler returns aggregate counters only:
upstream requests, parse requests, parsed paragraphs, cache hits, coalesced
requests, skipped paragraphs, cancellations, cooldowns, queue depth, and cache
size. These can be inspected from overlay DevTools with
`await window.ipcRenderer.invoke('gsm-jiten-request-stats')`.

From `GSM_Overlay`:

```sh
npm test
npm run test:jiten-electron
```

Unit tests use injected responses and reject direct Node HTTP requests. The
Electron smoke test creates a separate temporary profile and synthetic extension,
disables DNS, and verifies that both an extension service worker and renderer
share the broker. Its upstream is a loopback HTTP server reached through the
same broker path, exercising connection and body handling without contacting
Jiten. It never loads user settings or credentials.
Set `GSM_JITEN_TEST_ASAR` to an absolute packaged `app.asar` path to run the same
test against the shipped broker modules.
On headless Linux, run the Electron command with `xvfb-run -a`.

The repeated-frame regression submits 300 frames with 20 repeated Japanese
paragraphs and expects exactly one upstream parse batch. Additional coverage
checks partial cache hits, ordering, offsets, empty results, account separation,
rate and size bounds, cooldowns, state refreshes, cancellation, uncertain write
replays, custom endpoints, and shutdown. No live authenticated API check is part
of this suite. The parse/lookup contract follows Jiten's Reader controller linked
below, including UTF-16 `start`, `end`, and `length` offsets.

The Reader header originates in the sibling `JitenReader-GSM` repository's
`src/shared/jiten/request-by-url.ts`. Build there with `npm run build -- chrome`
and sync `jiten.reader/js/background-worker.js` and `js/settings.js` into the
overlay. These are generated bundles; preserve the source change when updating
Reader. The Electron regression includes an aborted renderer write followed by
a retry, asserting exactly one upstream write.

API references: [Jiten API guide](https://jiten.moe/guides/using-the-api),
[Reader controller](https://github.com/Sirush/Jiten/blob/master/Jiten.Api/Controllers/ReaderController.cs),
[parse throttle](https://github.com/Sirush/Jiten/blob/master/Jiten.Api/Services/ParseThrottleService.cs),
[Electron protocol forwarding](https://www.electronjs.org/docs/latest/api/net#netfetchinput-init).
