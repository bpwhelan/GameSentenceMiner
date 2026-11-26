# Desktop reading workspace

Home places the live textfeed beside a compact capture sidebar. **Your games**
sits inline at the top of the sidebar, **Game options** expands per-game
controls, and focus mode gives the reader the whole workspace. The new layout
follows the existing textfeed's typography, selection and reading behavior.

The reader shares GSM's live text protocol, corrections, mining selection, audio
replay, translation, screenshots and clip creation. It does not create a second
capture or statistics pipeline. On Windows, the selected Yomitan or Hachidori
extension scans the text in Home directly, using its existing scanning settings.
Its own popup appears beside the word, including the dictionary's readings,
definitions, audio and mining controls. There is no separate Home dictionary panel.

History is limited to 1,000 lines per profile. Restored or expired lines remain
readable; replay and media actions require a line in the active backend session.
Reading older text pauses following; **Follow latest** resumes it.

## Native desktop

`npm start` builds and starts Tauri. Rust owns windows, webviews, capture source
enumeration, clipboard, menus, tray, notifications, shortcuts and updates.
A bundled ordinary Node runtime hosts GSM's existing service code and supervises
Python, OBS, OCR, input services and the overlay. No Electron process is launched
or shipped. Existing `electron-src` names and development-only Electron types and
test fixtures remain to avoid an unrelated source-tree rename.

On Windows, WebView2 loads Yomitan and Hachidori as actual Chromium extensions.
Chromium owns their service workers, isolated content scripts, messaging, storage
and popups. Home and the overlay share the same browser profile. GSM does not
reimplement the extensions' Chrome APIs on Windows. The portable dictionary host
remains for WKWebView and WebKitGTK; work on those platforms is on hold until the
Windows experience is verified.

Native commands use inherited process pipes and per-window credentials. There
is no Electron service host or HTTP desktop bridge. Remote documents cannot
invoke desktop operations. Packaged apps include the native input server,
ordinary Node runtime, production dependencies, Python assets and dictionaries.

## Running and building

Install the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/),
Node 22.23.1 and the repository's Python/native build dependencies.

```sh
npm ci
npm start
npm run dev
```

For an isolated profile, after building:

```sh
npm run start:tauri -- -profile /absolute/path/to/profile
```

`build:tauri` builds services, the renderer and a development native executable.
`start:tauri` launches the latest successful development build. Immutable launch
copies let another build finish while the previous executable is still running.

```sh
npm run app:prepare
npm run app:dist
```

Bundle targets are Windows x64, Linux x64, and macOS ARM64/x64. macOS requires
14 or newer to keep separate persistent webview profiles. Linux needs WebKitGTK
4.1; overlays also depend on window-manager and capture-backend capabilities.
Build each target on its own OS.

## Existing profiles and dictionaries

GSM keeps the existing data-folder, profile and overlay paths. Windows copies the
existing extension databases, settings and Hachidori filesystem into the WebView2
profile before opening it. The original Electron data is preserved. If an older
unkeyed extension changed identity when its installation moved, a one-time import
transfers its data into a stable profile-local extension directory.

The portable import reads LevelDB and settings without opening either for writes.
Transfer preserves schemas, indexes, generated keys, deletions, typed arrays,
dates, large integers and media. The original profile is retained. Changes to the
source during export stop the transfer before publishing a usable snapshot.

Imports checkpoint committed batches for restart recovery. An existing native
dictionary database is never overwritten by an unrelated legacy transfer. Large
profiles can take time on the first lookup; progress is recorded in GSM's logs.

## Installers and updates

`native_desktop.yml` builds and tests all four targets before publication.
Stable and prerelease workflows call that same pipeline. Windows produces NSIS
and portable ZIPs, Linux AppImage and DEB, and macOS DMG and app archives.
Run **Publish Tauri desktop preview** from GitHub Actions on the branch to test.
It publishes a GitHub prerelease tagged `vX.Y.Z-preview.N` after validating the
signed installers. Choose **portable_only** for standalone test ZIPs instead.
Existing portable previews have their updater disabled and need a one-time
manual install from the release page to join the update channel.

Installed Tauri previews enable beta updates on first use. In GSM Settings,
enabling beta updates checks for the newest published version with a Tauri
manifest. Startup checks also follow the automatic-update preference.
The custom `preview` tag and Tauri-only manifest keep the current Electron beta
feed available to Electron clients.

Release builds require `TAURI_SIGNING_PRIVATE_KEY` in CI, matching
`plugins.updater.pubkey` in the Tauri configuration. Set
`TAURI_SIGNING_PRIVATE_KEY_PASSWORD` for a password-protected key. Every preview
update carries a Tauri signature. Stable Windows releases also go through SignPath
before updater signing. CI verifies the final bytes, public key and signed version.
Apple signing/notarization credentials
are separate. Local signing files are private and are not committed.

The stable release tooling also generates Electron updater metadata. The
Windows NSIS installer can remove the registered Electron installation through
its uninstaller and honor Electron's relaunch flag. Linux AppImage replacement
is another migration candidate. Test both from an installed Electron release
before offering a migration. macOS automatic migration additionally needs a
compatible code-signing identity. Previews built without Apple credentials use
an ad-hoc app signature. See the [Windows installer handoff](ELECTRON_TO_TAURI.md)
for the proposed backup, first-launch check and rollback sequence.

## Verification

```sh
npm run test:ts -- --maxWorkers=2
node --test desktop-runtime/tests/*.test.cjs
npm run test:native
cargo test --locked --manifest-path src-tauri/Cargo.toml
node scripts/verify-native-package.mjs
```

Native checks exercise real webviews, windows, imports and searches in both
dictionary engines, persistent dictionary reopening, downloads, Home and repeated
overlay startup/shutdown. Legacy transfer tests generate an actual Chromium
profile using a development-only fixture, verify native import and reopening,
and assert the original source files are unchanged. Linux can run the same
checks under Xvfb with `bash scripts/test-native-linux.sh all`.

See [Agent restart](AGENT_RESTART.md) for the warning and handoff procedure after
changes are built and checked. Local Windows and Linux checks do not substitute
for executing the macOS matrix on Apple hardware.
