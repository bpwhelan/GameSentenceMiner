# Native desktop package ownership

`npm run app:dist` builds the Python extension using the checkout's `.venv`,
builds the renderer and native helpers, stages resources, and produces the Tauri
installer and portable archive. `npm run app:dist:signed` additionally creates
signed updater artifacts. Nothing is published by these commands.

## Windows x64 measurements, 2026-11-12

Measured against the original `GSM_2026.11.0_x64-setup.exe` in this checkout:

| Payload | Before | After |
| --- | ---: | ---: |
| NSIS installer / native Windows update download | 398.2 MiB | 127.1 MiB |
| Application resources | 1108.1 MiB | 431.2 MiB |
| Desktop executable | 158.2 MiB | 38.9 MiB |
| Renderer resources | 98.6 MiB | 2.6 MiB |

The installer is 68.1% smaller. The new portable ZIP is 180.4 MiB. The remaining
largest files are Frida (112.6 MiB uncompressed), Node (83.0 MiB), and offline
language/dictionary assets. Removing those requires replacing active services
or changing offline capabilities, rather than a packaging exclusion.

A subsequent current-release-only changelog pass reduced its payload from
7,798,867 to 288,684 bytes (five files: manifest, current notes and three images).
Total staged resources are now 424.0 MiB in 5,026 files. The table above records
the first optimization pass. The rebuilt installer is 120.4 MiB (126,274,913 bytes),
another 6.7 MiB smaller; its archive contains only the current notes and three images.

The final NSIS archive was extracted and all 5,069 application files matched
the staged files by SHA-256. Its executable matches the built executable except
for Tauri's expected three-byte NSIS bundle marker. Offline Japanese tokenization
also passed using the extracted MeCab files. Local evidence and hashes are saved
under `build/size-audit/`; those generated files are not committed or packaged.

## What is shipped

- Tauri owns windows, capture, native OCR, menus, clipboard and updates. Capture
  source identities include executable paths from Rust; game detection and
  preview matching no longer load `node-window-manager` or `extract-file-icon`.
- The ordinary Node sidecar still runs GSM's existing services. Frida is retained
  for text hooking, along with the Node libraries those services actually use.
  Electron packages remain development dependencies for legacy migration tests;
  none are installed into the application resource directory.
- React, Markdown rendering and xterm dependencies are build dependencies. Their
  production output is already in the renderer, so their npm packages are not
  installed a second time for the Node sidecar.
- The renderer is served through the `gsm:` resource protocol. Tauri's
  `frontendDist` points at a minimal host document so it does not embed a duplicate
  renderer and legacy asset tree in the executable. The remaining legacy OCR
  replacement editor is copied with only its stylesheet and shared script.
- VOCR's four verified models are shared files under
  `GameSentenceMiner/assets/vocr`, used by Rust and Python. MeCab data, both
  dictionary readers, their fonts, model notices and license files remain
  available offline. Only MeCab executables for the target OS are shipped.
- Only the installed release's notes and referenced images/animations are bundled
  for offline use. The packaged manifest contains only that release; historical
  notes and media stay in the source repository and published GitHub releases.
  Prerelease builds prefer exact-version notes, falling back to the matching base
  release. If neither exists, an empty manifest allows the viewer's online fallback.

The abandoned `native/gsm-runtime` directory is never staged. It contained an
unused executable, FFmpeg distribution and DirectML DLL totaling about 449 MiB
in the audited checkout. Build objects, symbols, source maps, package tests and
fixtures are excluded as well. The unused RapidOCR model and hardcoded overlay
window diagnostic are also excluded.

## Checks and size limits

Staging writes `build/native-desktop/size-report.json` with totals and the largest
files. `scripts/native-package-policy.mjs` governs resource filtering and audits
the staged tree. Current limits are 6 MiB for renderer resources, 480 MiB for
Windows resources (including room for a prerelease Python wheel), 50 MiB for the
Windows desktop executable, and 160 MiB for the Windows installer. A failed check
stops the build. Change a limit only after reviewing the added payload.

```powershell
node --test scripts/build-native.test.mjs scripts/native-package-policy.test.mjs
node scripts/verify-native-package.mjs
node scripts/test-native-package.mjs
```

The package smoke test copies the release executable, bundled Node and staged
files outside the checkout so missing dependencies cannot resolve from the
developer's `node_modules`. It adds test fixtures and replaces only that isolated
copy's service entrypoint. It exercises the workspace, settings, both dictionary
readers and persistence, and real window capture through VOCR into the overlay.
Production resources are unchanged. Native Save dialogs are exercised by the
separate debug desktop dictionary tests, whose automatic save location is not
available in a release binary. Windows CI runs the isolated package test.

Unsigned rebuilds remove an earlier installer's signature, and collection removes
stale output signatures. Release publication still signs and verifies the final
bytes through the existing release workflow.
