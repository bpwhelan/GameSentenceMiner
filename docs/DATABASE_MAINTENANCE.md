# Database maintenance and game archives

Open **Tools → Database Maintenance** to see the database size, unused pages,
and original/archived sentence counts. **Vacuum now** compacts the database.
An optional weekly, 30-day, or 90-day schedule runs while GSM is open. Maintenance
is checked daily, including after the app next starts if a scheduled run was missed.
Automatic vacuuming and archiving are disabled initially.

Use **Archive game** in a game's menu on Games, Game Details, or Manage Games & Data.
The confirmation shows how many original sentences will leave the database. Archiving
keeps the game visible with an archive label. You can continue playing and archive
the new sentences later; saved history contributes only once.

To archive several games, open **Games → Select**, choose the games (or **Select all**
for the current filter), then click **Archive**. One confirmation covers the selection.
The batch continues in the background and reports progress per game. Games that fail
remain selected for retry; other selected games can still finish archiving.

Archives preserve:

- Characters, sentence totals, reading time, reading speed, sessions and hourly activity.
- Daily history, heatmaps, mined-card totals, media/translation counts, game metadata,
  genre and media-type statistics.
- Kanji frequencies and the global and per-game kanji grids.
- Available tokenized word frequencies, vocabulary novelty and first-seen history,
  including frequency dictionaries and words not in Anki.

With tokenization enabled, archiving finishes tokenizing the selected game's
sentences first. A failure rolls the operation back. If tokenization is disabled,
existing word data is preserved, but words cannot later be extracted from sentences
that were archived without tokenization unless their saved file is restored first.

## Saved files

Every manual or automatic archive first writes and verifies a compressed ZIP file
for that game. Only then does GSM remove the original rows from the database.
Files live in `archives/games` beside the database; **Tools → Saved Game Archives →
Archive folder** shows the full path. Each game has one `.gsm-archive.zip` file.
Archiving more sentences updates that file while keeping its previously saved
sentences. Files are retained indefinitely and are separate from database backup
retention.

In **Tools → Saved Game Archives**, you can:

- **Download ZIP** to keep a copy elsewhere. ZIP is a standard compressed format;
  inside it, `game_lines.jsonl` contains one record per sentence, including all
  database fields, translations, note IDs, media paths, and available vocabulary
  mappings. `manifest.json` describes the game and file format.
- **Restore** to put the original sentences back in the database. GSM replaces
  their archived statistics so they are counted once, skips sentences already
  present, and keeps the ZIP. Saved vocabulary requires tokenization to be enabled
  before restoration. Searches and sentence exports include the restored lines.
- **Delete file** to remove just the saved ZIP after confirmation. Statistics,
  reading history, word frequencies and kanji grids remain in the database. This
  copy of the original sentences is permanently lost unless downloaded or backed
  up elsewhere. You can also move or delete the ZIP in the displayed folder.

The files contain media references, not audio/image files themselves; archiving
does not delete existing media or Anki notes. Include the archive folder in your
backups if you want to retain its original sentences. Downloaded files can be
returned to that folder under their original filenames, then refreshed in Tools.

Restoration is transactional: an invalid file or failed rollup leaves database
history unchanged. If an earlier file was deleted, or a merge combined archived
games on the same day, a remaining file might cover only part of that archived
day. GSM refuses an automatic restore in that case because it cannot separate
all daily vocabulary statistics accurately. The ZIP still holds the original
text for extraction. Files already removed, and text archived by older versions
without a saved file, cannot be reconstructed from statistics.

## Scheduling and compaction

For automatic archiving, set **Archive completed games after inactivity** to a
number of days or weeks. Only games marked **Completed** qualify. Inactivity means
time since the game's latest captured sentence, and GSM rechecks it immediately
before archiving. Set the age to **0** to disable the schedule. Restoring a file
does not change game completion or this schedule, so an eligible completed game
can be archived again at the next scheduled check.

Archived sentences no longer appear in searches, sentence exports, or sentence
editing until restored. Their saved statistics and kanji grids remain available.

Vacuum after archiving to reclaim unused database pages. Both operations run as
background jobs; writing new sentences may pause while SQLite completes the work.
VACUUM needs temporary disk space for SQLite's rebuilt copy. Displayed sizes refer
to database pages; an active reader may delay release of a WAL file.

## Storage and rebuilding statistics

`archived_game_days` stores daily kanji maps and compressed numeric reading events.
Each event retains an ID, timestamp, character counts, card count, media flags and
tokenization coverage, without sentence text or media paths. Timing/count inputs are
needed for adaptive reading-time calculations and sessions that interleave games.
`archived_word_stats` replaces word-to-sentence mappings with per-game daily counts
and first/last-seen metadata. Word and kanji frequency filters over archives have
daily granularity, rather than individual occurrence timestamps.

Global and per-game daily rollups are rebuilt using both archive data and remaining
original sentences. Archiving and affected rollup writes use one SQLite transaction.
The regular rollup job also reads and writes each day within one transaction, so it
cannot persist a mixture of data from before and after an archive operation.

Text-cleaning character counts and kanji maps are fixed when archived. Changing
text-cleaning rules later requires restoring the sentences to reprocess them. Timing calculations
can still use the retained numeric inputs. Unlinking an archived game's external
metadata preserves its identity and statistics. Merging games carries both raw and
archived history. Permanently deleting a game removes its archived statistics.
Saved ZIP files are independent: neither merging nor deleting games deletes them.

Settings are stored with the database in `database_maintenance`. Scheduled work
uses GSM's existing cron runner. Manual operations use `/api/database/vacuum` and
`/api/games/<id>/archive`, returning job IDs from
`/api/database/maintenance/jobs/<id>`. Archive requests require `{"confirm": true}`.
`/api/database/archive-files` lists saved files; `/api/database/archive-files/<file_id>/download`
downloads a ZIP, and POST requests to `/restore` and `/delete` require the same
confirmation and return maintenance job IDs. File IDs resolve only within the
managed archive folder. Restore, file deletion, vacuum and game archiving share
the maintenance lock.

Files are published atomically before the database transaction commits. If the
database transaction subsequently fails, the ZIP may also contain sentences that
are still in the database; retrying or restoring safely deduplicates by sentence ID.
Archive exports need enough free space for a new compressed copy before replacing
the previous file. File-writing or verification failures leave the original
database rows and previous saved file intact.
