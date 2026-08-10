# GSM concurrency architecture

GSM treats concurrency as message passing between explicit owners. Domain state must not be mutated from transport callbacks, Qt callbacks, or arbitrary worker threads.

## Text ownership

`TextCoordinatorActor` is the only owner of live text identity, order, revision, and finalization. Producers create immutable `TextObservation` values and submit them through its bounded 2,048-item mailbox. The coordinator assigns `stream_sequence`; capture timestamps never determine stream order.

The coordinator emits immutable events in this lifecycle:

1. `append`: a provisional record is immediately visible.
2. `update`: a correlated, higher-quality observation revises the same `line_id`.
3. `freeze`: the quiet window expires or mining selects the record. Persistence, SRT, translation, and media work consume this final snapshot. Live stats consume append/update revisions immediately through an idempotent revision ledger.
4. `expire`: reserved for explicit retention removal.

Source authority is manual/hotkey, texthook, clipboard/external WebSocket, OCR, then periodic overlay OCR. A lower-authority source may not replace higher-authority text. Correlation only examines the newest provisional record and never crosses an intervening line.

`GameText` and `EventManager` are compatibility projections. They are not allowed to assign IDs or ordering for authoritative observations. Their public collection reads return snapshots.

## Runtime owners

| Owner | Mailbox/policy | Responsibility |
| --- | --- | --- |
| Text coordinator | 2,048, ordered | Text identity, order, correlation, revision, freeze, snapshots |
| Text projection | 2,048, ordered | Compatibility views and non-blocking subscriber dispatch |
| Database writer | 4,096, priority ordered | All SQLite writes and transaction ownership |
| Producer outbox | 256, ordered | Request/ack delivery and two-second freshness cutoff |
| TextFeed client | 256 deltas during snapshot | Atomic snapshot followed by ordered deltas |
| Overlay work | Latest request wins | Visual work may be superseded; text work may not |
| Overlay OCR loop | Dedicated interactive thread/asyncio loop | Capture/OCR never runs on the ingress or TextFeed transport loop |
| Blocking background pool | 128 total jobs | Bounded, below-normal-priority non-domain blocking work |
| Realtime tokenizer | 4,096 commands, ordered process queue | Tokenization in a low-priority spawned process with a separate GIL |
| Scheduled tasks | One spawned process per task | Cron/plugin work in a low-priority process with a separate GIL |

Ordered mailboxes return backpressure after 250 ms instead of silently delaying or dropping work. Latest-value mailboxes explicitly count coalesced work. Actor threads are named, supervised, and joined during shutdown.

## CPU isolation

On hosts with at least four logical CPUs, GSM reserves one latency CPU (two on hosts with at least eight) for the text coordinator, text projection, transport, TextFeed WebSocket, deadline, and overlay-dispatch threads. Managed background threads and spawned background processes are kept off that CPU set and run below normal priority. The interpreter switch interval is capped at 1 ms so any remaining Python-only helper thread cannot retain the main-process GIL for the default 5 ms slice.

CPU affinity and priority are best-effort on platforms that expose those controls. Process isolation is the hard boundary: scheduled tasks and realtime tokenization no longer share the live text interpreter or its GIL. SQLite persistence remains asynchronous and stats/TextFeed/overlay visibility never waits for it.

## Time model

- `stream_sequence`: authoritative live order.
- `captured_at_utc`: when source text/pixels were observed; used for media matching.
- `first_seen_at_utc`: when Python admitted the line; used for display order and statistics.
- `received_monotonic_ns`: durations, deadlines, and latency only.
- `finalized_at_utc`: frozen revision time.

Legacy naive datetimes are interpreted in the host timezone and normalized to UTC at ingress. Code must never assume insertion order is capture-time order.

## Ingress protocol

Electron and OCR send a bus request on `text.ingress.v2`:

```json
{
  "observationId": "producer UUID",
  "text": "raw source text",
  "source": "texthook",
  "sourceInstance": "hook id",
  "sourceDisplayName": "Luna · game.exe · #4",
  "capturedAt": 1786320000000,
  "emittedAt": 1786320000000,
  "revisionWindowMs": 100,
  "mergeFragments": true
}
```

The backend responds with `accepted`, `duplicate`, `backpressured`, or `rejected`, plus the observation and line identifiers when available. Producers retain at most 256 unacknowledged observations and retry until the backend acknowledges them, including across backend startup. The Electron broker never buffers this topic for a disconnected backend; producer outboxes own that buffering.

## TextFeed protocol

The bundled client requests `text_v2_snapshot_request`. That request is also the explicit capability negotiation boundary: an unnegotiated socket never receives a `text_v2_*` frame, and a negotiated v2 socket no longer receives legacy frozen `text_received` lines. Python replies with a `text_v2_snapshot` containing `snapshot_sequence`, then sends `text_v2_append`, `text_v2_update`, and `text_v2_freeze` deltas. Deltas generated while a snapshot is being written are buffered per client and drained afterward. A client that exceeds the 256-delta barrier is disconnected and recovers with a new snapshot.

Legacy HTTP routes, session sync, structured `text_received`, and plaintext output remain available. Legacy consumers receive one frozen value and therefore never render revisions as duplicates.

## Overlay projection

Text append and update events enqueue immutable compatibility lines into a single-slot `OverlayActor`. The actor owns the overlay processor generation and schedules OCR on the transport loop without blocking the authoritative text projection. The latest command remains pending across both startup boundaries—the processor becoming ready and the overlay WebSocket connecting—so the first visible text is not lost. Manual hotkey scans use the same owner. Newer commands coalesce older visual work explicitly.

## Startup and shutdown

Servers and actor threads start from application lifecycle functions, never by importing the WebSocket module. Standalone bus and WebSocket adapters acquire one managed `AsyncTransportRuntime`; the Electron backend shares the process-wide transport runtime. Backend cleanup closes source intake, freezes and drains authoritative text, stops its projections, flushes bounded database work, cancels overlay loop work and its platform hook, stops transports, and joins managed owners. Core actor failure appears in `/get_status` under `text_runtime` and marks the runtime unhealthy.

NDLOCR-Lite is not part of this architecture and must not be added.
