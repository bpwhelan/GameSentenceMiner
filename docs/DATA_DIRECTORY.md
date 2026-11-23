# GSM data locations

The application installation, active data folder, and location setting have separate jobs:

| Location | Contents |
| --- | --- |
| Application installation | Desktop executable and bundled application code, replaced by updates |
| Active data folder | GSM settings, `gsm.db`, logs, downloaded tools, and models |
| `~/.config/GameSentenceMiner/data_dir.json` | Small permanent file recording the active data folder |

On Windows, `~` means `%USERPROFILE%`. The default **data** folder remains
`%APPDATA%/GameSentenceMiner`; only the bootstrap file moves to `.config`.
On macOS/Linux, the default data folder was already `~/.config/GameSentenceMiner`.
`XDG_CONFIG_HOME` does not relocate the bootstrap file.

## Windows overlay data

GSM stores the default Windows overlay profile under
`%APPDATA%\GameSentenceMiner\Overlay`. On the first launch from an older
installation, GSM copies the settings and extension storage from
`%APPDATA%\gsm_overlay` before opening the profile. The copy skips browser
caches and incomplete transfer scratch files. GSM keeps using the legacy
profile if it cannot finish the copy, and keeps the original files after a
successful move. Existing path-based extension IDs can keep their original
unpacked extension location while reading their data from the new profile.

Portable profiles keep their existing layout.

## Mining settings

**Settings → Open Main GSM Settings** opens a dedicated Tauri window that edits the active data folder’s `config.json`. Global credentials and connection settings apply to every game. A base profile holds mining preferences. A game can inherit individual values from its base or keep its own overrides. Creating a game with inheritance turned off copies the base’s current values. Selecting a profile in the editor chooses what to edit. **Use in GSM** activates it.

During the first upgrade, GSM takes shared connection values from the active profile. If existing profiles disagree, GSM writes a copy of the original document beside `config.json` and displays its filename in Global settings.

The Rust scope rules live in `native/gsm-settings/src/mining_scopes.rs` and its `schema` module. Each save publishes the shared fields, overrides, and resolved `configs` in one atomic write. Desktop controls that modify mining settings use `mining_scopes::update`. Readers can consume the active resolved profile directly. The desktop sends `settings.mining.changed` without a configuration payload so subscribed views can reload their own scope. The unified port and listening address take effect at the next launch.

## Selecting a folder

The Windows assisted installer offers a data-folder page after the application-folder
page on a fresh per-user install. Select an empty, writable folder separate from the
application installation. The choice is saved only when installation succeeds, not when
clicking Next or cancelling. Paths containing spaces and Unicode are supported.

When an existing pointer or existing default data is found, the installer displays and
preserves that location. Updates and silent installs do not replace it. For machine-wide
installs, each user's location remains managed by GSM, avoiding writing another user's
selection from an elevated installer. Uninstalling preserves both the data and pointer.

In **Settings > Data Folder**, GSM shows the current folder, database path, and the
location of the bootstrap file. Changing folders stops the backend, OCR, OBS, and overlay,
copies the configuration and database, commits the new location, and restarts GSM.
Source files remain available for manual cleanup. Downloaded tools are prepared in
the destination. Tauri keeps any legacy Python environment in place for rollback.
Use dictionary export and import when moving Chromium profiles and Yomitan databases
between data folders. See [Electron to Tauri first install](ELECTRON_TO_TAURI.md).

**Use Original AppData Folder** explicitly switches to the data already in the original
folder; it does not merge newer changes from the custom folder. This is stated in the
Settings UI and confirmation dialog. The explicit default selection is also saved,
preventing a stale legacy pointer from taking over on the next launch.

## Manual path files and environment overrides

Close GSM before editing `data_dir.json`. This format remains supported:

```json
{
  "version": 2,
  "dataDir": "D:\\GSM Data"
}
```

The existing `{ "dataDir": "..." }` format still works. Paths must be absolute;
`~/...` is also accepted. UTF-8 files with or without a BOM are supported. A saved
location continues to be selected if its directory is missing. GSM recreates it when
possible, or reports an access error, instead of silently switching back to old data.
Invalid bootstrap files produce a startup error naming the file to fix.

Python uses `GSM_DATA_DIR` first (Electron sets it for its children), then the pointer,
then the platform default. Electron resolves the pointer afresh on each launch, ignoring
the inherited child-process override so relaunching after a move cannot reuse the old
path. The database, logger, speech cache, locale sync, and overlay config use this same
active location. Test databases continue to use the isolated test root.

## Existing relocation repair

If the stable pointer is absent, a legacy `data_dir.json` in the original data folder is
automatically migrated. On macOS/Linux the same file is upgraded in place. The old
Windows pointer is retained, but the stable pointer always takes precedence. After
migration, deleting the old Windows AppData folder cannot reset the selected location.

Older versions incorrectly kept writing to the original `gsm.db` after relocation.
Migrated pointers temporarily record `legacyDatabaseDir`. Before opening its database,
the desktop repairs this once using SQLite's backup API, including committed rows still
in the original WAL. Any existing destination database and sidecars are preserved under
`<data>/backup/data-directory-migration/<unique-id>/`. The original database is kept.
The marker is cleared only after the replacement succeeds; failures leave it retryable.
If the original database has been deleted, the destination copy is retained.
Moving again is blocked until this one-time repair finishes, so a second relocation
cannot discard the pending repair and copy the stale database.

A small `database-migration.lock` file beside the pointer coordinates processes using
SQLite locking. A failed process cannot leave a permanent lock. Do not remove the
bootstrap directory when cleaning up old data.

## Implementation and verification

Keep these implementations of the pointer contract aligned:

- `electron-src/main/data_dir.ts`: early Electron startup, atomic pointer writes.
- `GameSentenceMiner/util/data_directory.py`: dependency-free Python resolver.
- `build/data-directory.ps1`: Windows installer inspection, validation, initial write.
- `native/gsm-db/src/profile.rs`: desktop database repair before opening history readers.
- `GameSentenceMiner/util/database/data_dir_migration.py`: standalone Python compatibility.

Focused regression checks:

```powershell
npm run test:ts -- electron-src/main/data_dir.test.ts electron-src/main/services/data_relocate.test.ts electron-src/main/services/data_directory_installer.test.ts electron-src/renderer/src/components/tabs/SettingsTab.test.tsx
.venv/Scripts/python.exe -m pytest tests/util/test_data_directory.py tests/util/config/test_get_app_directory.py
npm run build:main
npm run build:renderer
```

Installer helper tests run PowerShell against temporary profiles without installing GSM
or writing to the current user's AppData, registry, or bootstrap file. The NSIS include
is compiled by `npm run app:dist` using electron-builder's assisted installer template.
