# Managed OBS updates

On Windows, **Settings → Updates → OBS Studio** manages GSM's portable OBS.
Manual updates are the default. Checking shows the available version; updating
downloads and verifies the official architecture-specific ZIP, prepares it in a
separate directory, then closes OBS cleanly and swaps installations. The full
portable configuration and third-party plugins are preserved. Active recording
or streaming prevents an update. A previously active replay buffer is resumed.

**Automatically update OBS at startup** is independent of OBS's own updater.
It checks once per GSM launch, with no update reminders. Failures and busy OBS
instances leave the working installation available and are reported in logs and
the OBS settings panel. Custom OBS installations and remote connections are not
updated by GSM. macOS and Linux continue using their system OBS installation.

The previous binaries and configuration remain in `obs-studio.previous` beside
`obs-studio`. **Restore OBS …** swaps back to that complete installation,
including its older configuration, and disables automatic OBS updates. GSM pauses
and restores its backend and OCR clients around the OBS restart. A failed
connection/version/replay-buffer check during an update restores the old copy.
Interrupted directory swaps are recovered before the next startup installation
check. GSM waits for its OBS update to finish before quitting or relocating data.

## Choosing the release

`GameSentenceMiner/assets/obs-release-policy.json` is shared by the Electron
installer/updater and the standalone Python installer:

```json
{ "version": null }
```

`null` selects the latest stable GitHub release. To approve a fixed version for
new installs and managed updates, set `version` to an exact tag such as
`"33.0.1"`. Restart GSM after changing this policy. Managed updates never
automatically downgrade an already newer installation. The policy currently
remains unpinned so OBS 33 can be tried before choosing a baseline.

OBS's own **Allow OBS to Update Itself (Advanced)** option remains separate and
off by default. GSM-managed updates do not enable OBS's own update prompts.

OBS 33's bundled plugins live under `core`. Both download paths preserve that
required runtime, including the browser module: OBS 33 stops loading subsequent
core modules if the browser module is missing. Only the older shared CEF files
are pruned. Managed updates verify the browser and WebSocket core modules before
closing the installed OBS.

## Checks

```powershell
npm run test:ts -- electron-src/main/services/obs_runtime.test.ts electron-src/main/ui/obs.test.ts electron-src/renderer/src/components/tabs/ObsUpdates.test.tsx
.venv/Scripts/python.exe -m pytest tests/util/downloader -q
```
