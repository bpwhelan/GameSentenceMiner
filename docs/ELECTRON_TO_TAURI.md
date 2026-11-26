# Updating from Electron to Tauri on Windows

The existing Electron updater can deliver the Windows Tauri installer directly. Use a stable release version greater than the latest shipping Electron version. The coordinated release workflow signs the Windows installer, calculates the Electron feed SHA-512 from the final bytes, and publishes the native signed update manifest. Published Tauri previews continue to use their own feed.

## What the user sees

The release notes explain the desktop rewrite before the download. Electron verifies the download, stops its services and runs NSIS. The installer asks whether to switch even when Electron requested a silent update. **No** is the default. Declining a request from Electron reopens the registered Electron application when its executable is available. A manual first install over a registered Electron installation shows the same prompt.

**Yes** creates a snapshot before installing the native desktop. The installer keeps Electron in its original folder and adds the **GSM** application. The new desktop opens the existing data folder and uses the normal first-launch database and dictionary migrations. Once Tauri is installed, its ordinary native updates use its signed feed.

## Snapshot and recovery

Look in `backup/electron-handoff` under the active GSM data folder. Each completed attempt has a separate timestamped directory. Its `snapshot.json` records the versions and original paths. The installer checks each SQLite backup with SQLite's quick check and includes committed WAL pages. A failed preparation stops installation. A retry creates another snapshot and retains the earlier one.

The snapshot contains the existing `gsm.db`, `config.json`, `electron/config.json`, the active folder's `owocr_config_gsm.ini`, and copies of the stable and legacy directory pointers that existed. If an older relocation still needs database repair, `legacy-gsm.db` preserves the separate source database. Downloads, recordings, the original browser profile and the legacy Python environment stay in their original locations.

Before returning to Electron after opening Tauri, exit both applications and their services. Preserve a separate copy of the current database, its WAL/SHM/journal files, settings and pointers so work done after the update remains recoverable. Restore the pre-update database to the data folder recorded in the snapshot, moving the newer database and its sidecars out together first. Restore the saved settings and pointers to their recorded locations. If a pointer was absent before the update, move any newer copy aside. A pending relocation can have both an active and a legacy source database. Restore each to its corresponding location. Open **GameSentenceMiner** to return to Electron, or **GSM** to launch Tauri.

## Installer regression test

The **Windows Electron migration** workflow recreates the installed Windows 2026.10.2 release on a disposable runner and checks the executable and application archive against their original SHA-256 hashes. It bundles the released Tauri preview executable and resources with the current installer hooks. The fixture serves the update over loopback and redirects only the running Electron updater's provider. The renderer invokes the same installation command as the Install button.

The workflow exercises both decisions after a real Electron download. With the default data folder, declining reopens the original Electron desktop. With a relocated Unicode data folder, accepting must start the registered Tauri executable and bring its gateway and intake to ready. The tests also reject a damaged installer download, block migration for a corrupt database, retry with a valid game-history row, and verify the backup, preferences and browser-profile sentinel. The Rust helper tests also cover corrupt databases, retry preservation and older relocation pointers. The stable Windows release job repeats the installed-client exercise with its final signed installer before publication. Dictionary content and lookup behavior have dedicated transfer tests in the native desktop matrix.

macOS and Linux use their existing platform update mechanisms. The NSIS consent and snapshot workflow applies to Windows.
