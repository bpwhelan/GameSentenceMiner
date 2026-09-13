<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# The Hachidori extension

This folder is the extension exactly as Chrome loads it: a Manifest V3
extension for Chrome 128 or newer with no build step. The JavaScript is plain
ES modules and classic scripts, the dictionary engine is committed
WebAssembly under `vendor/`, and everything runs inside the browser. To run
it from a checkout, open `chrome://extensions`, turn on **Developer mode**,
choose **Load unpacked** and select this folder. `scripts/package-store.py`
zips this same folder, with the licence files, for the Chrome Web Store.

[The architecture guide](../docs/architecture.md) explains how the pieces
work together and lists every runtime message and stored key. This page says
where things are.

## Entry points

`manifest.json` names them.

| File | Runs as | Role |
| --- | --- | --- |
| `background.js` | the service worker | Routes every runtime message and owns everything in `chrome.storage.local`: dictionary metadata, options, the personal dictionary, update schedules, lookup counts, first-run and sharing state. It also owns the alarms, the Anki gateway and the sharing host and client. It holds no engine state, so Chrome may stop it whenever it is idle. |
| `content.js`, with the classic scripts listed under `content_scripts` | every web page | Scans the Japanese text near the pointer, renders the popup in a closed shadow root through `render/popup.js` and `render/glossary.js`, and adds the popup's Anki, pronunciation and capture controls (`anki-content.js`, `audio-content.js`, `capture-content.js`). `content.css` is the only style the page itself receives: the source highlight. |
| `offscreen.html`, `offscreen.js` | one offscreen document the service worker creates | Owns the dictionary engine. `engine-worker.js` runs the pthread build with direct OPFS once `opfs-capability-worker.js` has proved the browser can; `engine-service.js` is the single-thread IDBFS fallback. Pronunciation, Anki, media capture and the first-run installer load here on demand. |
| `settings.html`, `settings.js` | the options page | Dictionaries, groups, updates, the personal dictionary, Reading, Design, pronunciation, Anki, keybinds, media capture, backup and sharing, with global search. The larger sections have their own `*-settings.js` controller; `design-preview.html` is the live preview inside Design. |
| `startup.html`, `startup.js` | a tab opened once after install | First-run setup: recommended dictionaries, Anki detection, a practice lookup, and the offer to use a Hachidori that another browser on this computer already shares. Overlay mode skips it. |
| `toolbar.html`, `toolbar.js` | the toolbar button's popup | Turns lookups on and off, shows the sharing state, starts a screen recording and opens Settings. |
| `capture.html`, `capture.js` | a tab opened from the toolbar or Settings | Controls media capture. The recorder itself, `capture-host.js`, runs in the offscreen document and keeps going when this tab closes. |

`render/reader.css` and the icons in `render/icons/` are the only files web
pages may fetch (`web_accessible_resources`); the popup and its Anki controls
load them.

## Modules by feature

Files share a prefix with the feature they belong to. A rule that more than
one context needs lives in a module with no Chrome dependency, so Settings,
the service worker and both engine runtimes run the same code.

- **Dictionaries and stored state.** `reader-options.js` is the one stored
  options view every context reads. `dictionary-group-state.js` and
  `dictionary-groups.js` hold the group rules and their Settings controls,
  `dictionary-name-drafts.js` the autosaved names, `dictionary-progress.js`
  the import progress. `managed-dictionary-source.js` and
  `recommended-dictionaries.js` define the trusted update sources and the
  starter set; `custom-dictionary.js` the personal dictionary's source format
  and archive; `setup-state.js` and `setup-installer.js` the first-run stages
  and the installer that runs them. `json-value.js` and `response-limits.js`
  are the comparison and size rules the transaction boundaries share.
- **Lookup statistics.** `lookup-stats-identity.js`, a classic script so the
  content script can use it, and `lookup-stats.js`.
- **Anki.** `anki.js` is the AnkiConnect gateway and `anki-setup.js`
  recognises an existing mining setup. `anki-templates.js`, `anki-values.js`,
  `anki-glossary.js`, `anki-resources.js` and `anki-audio.js` build the note
  fields and media; `anki-duplicates.js` and `anki-enrichment.js` handle a
  note that already exists; `anki-digest.js` hashes media. `anki-mining.js`
  and `anki-worker.js` are the mining service in the service worker.
  `anki-offscreen.js` and `anki-maturity-worker.js` parse bulk note data off
  the main threads for `anki-maturity.js` and `anki-maturity-cache.js`, which
  supply the mature words behind definition blur.
- **Pronunciation.** `audio-sources.js`, `audio-repository.js`,
  `audio-cache.js` and `audio-player.js` fetch, keep and play audio in the
  offscreen document (`audio-offscreen.js`); `speech.js` wraps the browser's
  text-to-speech.
- **Media capture.** `capture-host.js` is the offscreen recorder.
  `capture-session.js`, `capture-buffer.js`, `capture-timeline.js` and
  `capture-speech.js` are its bounded buffers, occurrence timeline and speech
  detection. `capture-audio-worklet.js`, `capture-frame-client.js` with
  `capture-frame-worker.js`, and `capture-encoder-client.js` with
  `capture-encoder-worker.js` move audio sampling, frame grabbing and animated
  AVIF encoding (`avif-sequence.js`) off the main thread.
  `texthooker-protocol.js` parses the text a texthooker sends.
- **Backup.** `backup-archive.js` is the archive format, `backup-state.js`
  the snapshot rules, `backup-downloads.js` the pending downloads and
  `backup-settings.js` the controls.
- **Sharing.** `sharing-protocol.js` is the wire contract both sides import;
  `sharing-host.js` and `sharing-client.js` are the two roles in the service
  worker; `sharing-settings.js` is the Settings section. `anki-relay/` is the
  Hachidori Relay add-on for Anki, in Python, and `anki-addon.js` packages it
  into the `.ankiaddon` that Settings hands out.
- **Pages.** `settings-search.js` and `settings-dom.js` serve Settings;
  `keybind-settings.js`, `custom-link-settings.js` and `external-links.js`
  the keybinds and the custom links in the popup; `local-file-access.js` the
  notice about Chrome's *Allow access to file URLs* permission;
  `startup-practice.js` the practice step. `visual-novel.js` and
  `visual-novel.css` draw the background scenes behind the startup page and
  the Design preview from the images in `assets/` (see
  `assets/ATTRIBUTION.md`); `design-preview.js` renders the preview from
  `sample-meal.svg` and local sample data.
- **Renderer.** `render/` is the popup renderer ported from GameSentenceMiner,
  which adapts Hoshi Reader and Yomitan; `render/ATTRIBUTION.md` records what
  came from where.
- **Overlay mode.** `overlay-mode.js` is the one switch a host such as the
  GameSentenceMiner overlay flips in its copy; see
  [overlay mode](../docs/overlay-mode.md).
- **Vendored code.** `vendor/hoshidicts-threaded.{mjs,wasm}` and
  `vendor/hoshidicts.{mjs,wasm}` are the two builds of the hoshidicts engine
  from `wasm/build.sh`, `vendor/avif-encoder.{mjs,wasm}` the AVIF encoder
  from `wasm/avif/`, and `vendor/zip.js` the pinned zip.js runtime. They are
  committed build output: update them with their source change and otherwise
  leave them alone.
- `icons/` holds the extension's icons.

## Conventions

- Every script, stylesheet and page starts with an
  `SPDX-License-Identifier: GPL-3.0-or-later` line; the files under `render/`
  also keep their upstream copyright lines.
- A rule the content script needs as well as the module contexts lives in a
  classic script that publishes one `globalThis.HD…` object
  (`HDReaderOptions`, `HDLookupStats`, `HDDictionaryGroups`, …); modules
  import such a file for its side effect.
- Runtime messages are objects with a `target` and an `hd_*` `type`, and
  they carry explicit ids, revisions or generations so a stale reply fails
  closed. Stored values are revisioned and written only by the service
  worker; a page edits them by compare-and-set. The offscreen document never
  touches `chrome.storage` itself.
- Nothing here is generated except `vendor/`. There is no bundler,
  transpiler or minifier: what is committed is what ships.

## Checking a change

```sh
node test/make-fixture.mjs      # writes the dictionary fixtures once
node test/extension-smoke.mjs   # this folder's JavaScript against the real engine, in Node
node test/chrome-e2e.mjs        # this folder loaded unpacked into a real Chrome
```

[The test guide](../test/README.md) says what each suite proves and how to
install the browser and jsdom they need; the validation list in
[AGENTS.md](../AGENTS.md) says which checks each kind of change requires.
Sharing changes have their own suites, listed in [sharing](../docs/sharing.md).

## More

- [Privacy](../docs/privacy.md): what leaves the browser, and when.
- [Sharing](../docs/sharing.md), [overlay mode](../docs/overlay-mode.md),
  [media capture](../docs/media-capture.md),
  [the backup format](../docs/backup-format.md),
  [update schedules](../docs/update-schedules.md) and
  [lookup statistics](../docs/lookup-statistics.md) describe those features.
- [Building a source archive](../docs/source-build.md) covers `wasm/` and
  the `third_party/hoshidicts` submodule behind `vendor/`.
