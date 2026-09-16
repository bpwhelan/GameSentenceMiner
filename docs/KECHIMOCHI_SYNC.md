# Kechimochi sync

GSM can automatically reconcile its complete reading history and media library with
Kechimochi's desktop HTTP API. The first run starts at the earliest available GSM
activity. Every later run checks all dates again, including corrections to old data.

## Setup

1. Open Kechimochi and turn on **HTTP API** in its profile tab.
2. Open **Tools → Kechimochi Sync** in GSM.
3. Use `http://127.0.0.1:3031`, or the HTTP API URL for your Kechimochi instance.
   **Test connection** checks the URL without changing Kechimochi data.
4. Enable **Automatically sync all GSM history** and save.

Saving with automatic sync enabled starts the first full sync immediately. The
default frequency is every 15 minutes; hourly and daily schedules are also available.
Daily times use the computer's local time. Both apps must be running for a sync to
complete. GSM catches up on overdue runs after restarting. Connection failures retry
within 15 minutes, including failures during the first backfill or a manual run.

Use **Preview history** to see the total scope, earliest/latest dates, and the first
100 activities. **Sync now** runs the same complete reconciliation as the scheduler.
Save settings changes before previewing or syncing. Status and the last successful
sync are saved in the GSM database and remain available after restarting.

## What gets synced

- All GSM library entries, including planned/unplayed media, titles, descriptions,
  content types, completion/status, metadata links, and identifiers.
- One native activity per game and local calendar date: cleaned GSM character counts
  and GSM's reading-time calculation. There is no minimum character threshold and
  no launch-date cutoff.
- Live lines, archived reading events, and older aggregate-only daily history.
  Live/archived events take precedence over cached daily rollups for the same game
  and date. Missing rollups do not leave holes in the exported history.
  Original JSON daily rollups are also supported. Days whose only surviving data
  is an unassigned daily total appear under **GSM historical activity**.
- External stats such as Mokuro and manual entries, enabled by default. Each source
  entry keeps its own stable identity, including when its date or values change.
- Cover images, enabled by default. These require **Full** scope under Kechimochi's
  advanced HTTP API settings. With **Automation** scope, activity and metadata still
  sync; the status explains that covers are pending. Covers retry on later runs.

Language follows GSM's configured target language, as in the CSV exporter.
Kechimochi accepts whole minutes, so each activity's duration is rounded to the
nearest minute. GSM keeps its original precision.

This is one-way sync: GSM controls its synced activity. Editing,
moving, or deleting activity in GSM is reflected in Kechimochi. Disabling external
stats removes previously synced external activity from the managed destination.
Unrelated Kechimochi logs and user notes are preserved. Media entries are retained
when GSM activity disappears because they may contain other Kechimochi history.
Turning automatic sync off leaves the destination as it is.

## Metadata and pictures

Descriptions and existing GSM cover images are copied directly. Cover uploads need
**Full** scope in Kechimochi's advanced HTTP API settings. If the status reports
that scope is missing, enable Full and use **Sync now**, or let the next scheduled
run upload the pending images. No CSV export or manual image selection is needed.

Metadata uses Kechimochi's readable fields, including **Character count** (the
media's total length), genres, tags, release date, and alternate titles. Saved IDs
and links become **Source (VNDB)**, **Source (Anilist)**, **Source (Jiten.moe)**,
and other source fields. For supported URLs, Kechimochi displays its own
**Refresh Metadata** button beside the field. Use it to fetch additional information
and pictures and review Kechimochi's merge dialog. The desktop HTTP API does not
expose that metadata-import workflow, so a source link alone does not fetch it
automatically; GSM supplies the metadata and images already in its library.

Later syncs fill missing fields and apply changes made in GSM. Descriptions and
metadata enriched inside Kechimochi survive while the corresponding GSM value is
unchanged. Additional fields such as publisher or developer are preserved. Clearing
a GSM field removes its synced value only if that value was not edited in Kechimochi.
GSM stores comparison hashes locally for each destination. Editing or refreshing
metadata in Kechimochi also preserves the sync identity and does not create duplicates.

## Existing CSV imports

If you previously imported GSM CSV activity, enable **Reuse exact matching activity
logs** before the first sync. This option adopts a single matching log with the same
media, date, character count, whole minutes, and a compatible activity type. It only
adopts logs without notes. It supports the older GSM CSV content-type activity labels.

Adopted logs become managed by GSM. Ambiguous matches stop the run with an error;
GSM does not guess which duplicate to adopt. Modified, split, or partial CSV imports
cannot be reliably identified automatically. Resolve those in Kechimochi before
enabling sync. CSV download/export remains available independently.

## Recovery and ownership

Each GSM database receives a stable sync identity in `kechimochi_sync_state`.
Kechimochi media records store a `gsm_sync` JSON string in `extra_data` (older
object markers are also accepted); activity notes
contain a `[GSM sync:…]` marker. Leave these markers in place. Additional notes and
unrelated media metadata are preserved.

Every run reads the current remote media and activity lists. If Kechimochi saved a
POST but the connection dropped before GSM received the response, the next run finds
the marker and updates/reuses the record. Successful partial work remains reusable.
GSM does not blindly retry POSTs or rely on a cursor advancing after a batch.

Historical edits update existing logs. Records removed remotely are recreated while
they still exist in GSM. Obsolete GSM-owned logs are removed only after a complete
source snapshot and successful upserts. A snapshot error cannot trigger pruning.
Duplicate ownership markers stop reconciliation for review.

A nonblocking OS file lock prevents manual and scheduled workers from syncing the
same GSM database concurrently, including across Windows subprocesses. The operating
system releases the lock if a worker dies. Per-destination status is stored separately
so changing the API URL does not reuse another destination's reported progress.

## Implementation and verification

- Client: `GameSentenceMiner/util/kechimochi_client.py`
- History reconciliation: `GameSentenceMiner/util/kechimochi_sync.py`
- Persistent state: `GameSentenceMiner/util/database/kechimochi_sync_state.py`
- Scheduling: `GameSentenceMiner/util/cron/kechimochi_sync.py`
- API and Tools UI: `GameSentenceMiner/web/kechimochi_api.py` and the
  `kechimochi-sync` template, JavaScript, and CSS files.

The client implements the [Kechimochi HTTP API](https://github.com/Morgawr/kechimochi/blob/v0.3.2/docs/http-api.md)
and is verified against the desktop `http-0.3.2` API. It uses the media, activity,
version, and optional cover-upload endpoints, without authentication or CSV uploads.

Run regression checks with the repository's `.venv`:

```powershell
.venv/Scripts/python.exe -m pytest tests/web/test_kechimochi_sync.py
npm run test:ts -- electron-src/main/ui/kechimochi-sync.test.ts
```

The optional live test creates uniquely named fixture media, exercises interrupted
requests, repeat syncs, historical edits, and deletion, and cleans up only its fixtures:

```powershell
$env:GSM_KECHIMOCHI_LIVE_URL = 'http://127.0.0.1:3031'
.venv/Scripts/python.exe -m pytest tests/web/test_kechimochi_sync.py -k live_kechimochi
```
