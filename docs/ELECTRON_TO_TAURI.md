# Electron to Tauri first install

## Release order

Ship one Windows Electron bridge release through the existing Electron updater. Start the bridge from the last shipping Electron branch and give it a version between the current Electron release and the first stable Tauri release. Keep the bridge available to older Electron clients after the Tauri release goes live. Give Tauri its own signed update feed as it uses today.

The current release tooling generates both Electron and Tauri feeds from the native release assets. The Windows Tauri installer also calls the registered Electron uninstaller during preinstall. Before shipping the bridge, route Electron's feed to the bridge release and change the Tauri install path to preserve Electron until Tauri has started successfully. Verify direct manual upgrades from older Electron versions as well as upgrades through the bridge.

## Windows bridge handoff

1. The bridge offers the migration and identifies the exact signed Tauri installer for this OS and architecture. Pin its release version and digest in the signed bridge, verify the downloaded bytes and the Windows publisher, and stage the installer outside Electron's install directory. Download and verification can finish while Electron is running.
2. When the user confirms, resolve the GSM data folder using the existing data-directory resolver. Ask Electron to stop its backend and close the app. A separate process can wait on that specific Electron process and report shutdown failure without terminating unrelated processes.
3. Once GSM and its backend have closed, create a verified pre-upgrade SQLite snapshot that includes committed WAL changes and save the current configuration and data-directory pointer alongside it. Reuse the existing SQLite backup path. Keep Electron's overlay profile available to Tauri's existing dictionary importer.
4. Run the staged Tauri installer with its normal WebView2 setup. Install the Tauri executable separately from Electron and defer shortcut ownership changes. Save a small, atomic handoff record with the source and target versions, selected data path, backup location and current step. Retry the failed step using the same backup.
5. Launch Tauri with the resolved data folder and pass a unique handoff ID. Tauri acknowledges that ID and its own version when the native database, gateway and intake are ready. Use that receipt for installer completion. Dictionary transfer can continue when the reader opens, with the original profile retained if transfer fails.

## Recovery and cleanup

- An installer failure before Tauri opens the data folder leaves Electron available. If Tauri fails after opening the folder, stop Tauri and recover from the pre-upgrade snapshot before launching Electron. Keep a copy of any database or config written after cutover before restoring. The saved config and pointer are part of the restore.
- A successful migration can offer to remove the Electron binaries and hand over the shortcuts. The bridge keeps an installer for the previous Electron version available through its rollback window. Clean installs go straight to Tauri and use its native setup flow.
- Tauri records `.gsm-venv-retired.json` inside the existing `python_venv` under the shared data directory. The marker has the UTC timestamp, Tauri version and Python version when available. Tauri keeps the original path usable for Electron rollback. A later cleanup tool should confirm the marker, the resolved data root, link status, the end of the rollback window and the absence of a legacy install before offering removal.
- macOS and Linux need separate installer handoffs. They can use the same backup and receipt contract with their own bundle replacement and rollback mechanics.

## First installer checks

Test a clean Windows user without Python or uv and an Electron upgrade with default and relocated data folders. Test a database with committed WAL rows, populated Yomitan and Hachidori profiles, and a path containing spaces and Unicode. Cancel before shutdown, fail the installer, interrupt the first Tauri launch, retry after interruption and restore to Electron after a schema upgrade. Verify that a second attempt keeps the original snapshot and that clean install and repair never provision Python.
