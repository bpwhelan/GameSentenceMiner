# Windows Speech Recognition PoC

This experimental input captures process-loopback audio from the window currently targeted by OBS/GSM, feeds 16 kHz mono PCM to a native Windows speech helper, and sends partial/final recognition results through GSM's authoritative text pipeline. The capture pair is restarted when the targeted HWND or owning process changes; changing focus to another application does not retarget speech recognition.

## Build

On Windows x64 with Rust/Cargo, CMake, and Visual Studio 2022 installed:

```powershell
npm run build:windows-helpers
```

The speech build downloads Microsoft Cognitive Services Speech SDK 1.41.1 through CMake's NuGet `FetchContent` step. Packaged Electron builds run this helper build automatically and include the resulting executables under `resources/native`.

## Run

The Windows Speech tab in the main Electron app owns the workflow. The tab is hidden by default; enable it under **Settings → Visibility Settings → Visible Tabs**. Select an OBS scene, configure its recognizer, and use **Start Speech Recognition** and **Stop Speech Recognition** in the tab. Runtime messages and recognized partial/final text appear in the tab's local recognition log.

Settings are saved per OBS scene under `windows_speech_config` in GSM's data directory. They are not part of GSM profiles. Changing profiles does not start, stop, or reconfigure recognition. Changing the active OBS scene invalidates the current service immediately and leaves it stopped; start it explicitly from the tab for the new scene.

On first start, the default `embedded` backend downloads and extracts the [DirectLiveCaptions bundle](https://r2.gamesentenceminer.com/DirectLiveCaptions.zip) into GSM's data directory, then uses the bundled runtime and model package. The archive is roughly 358 MB and expands to roughly 492 MB. Later starts reuse the cache without downloading again. English and Japanese are currently supported; the bundle also contains Chinese for future use.

The native helper includes the same public direct-call compatibility license used by LunaTranslator. A user-provided license can override it through either:

```text
GSM_WINDOWS_SPEECH_LICENSE
GSM_WINDOWS_SPEECH_LICENSE_FILE
```

or the scene's advanced license-file field. Helper/model/runtime locations can be overridden with the corresponding `GSM_WINDOWS_*` environment variables or the scene's advanced fields. Set `GSM_WINDOWS_SPEECH_CACHE_DIR` to relocate the extracted bundle, or `GSM_WINDOWS_SPEECH_BUNDLE_URL` to test a mirror.

If the bundled files are already present, GSM uses them before searching the installed Windows Live Captions package. If downloading fails, the PoC falls back to a compatible installed package when one is available.

The `sapi` backend is retained as an experimental fallback for systems exposing a usable desktop dictation grammar. It is not expected to work on every Windows installation.

## Diagnostics

The audio helper can be tested without starting GSM:

```powershell
native\windows-audio-capture\bin\x64\gsm-windows-audio-capture.exe --root-pid $PID --sample-rate 16000 --channels 1 --probe
```

The speech helper's `--probe` option checks model/runtime initialization without consuming audio. Recognition fragments use the same sequential-merge behavior as Luna's path, with `speech_recognition` source metadata containing the targeted window and process identity.

This remains a PoC: Windows model versions, licenses, speech packages, and SAPI availability vary by OS build. If the audio probe passes but the speech probe reports model/license/runtime errors, the blocker is the host's speech runtime rather than the targeted-window capture path.
