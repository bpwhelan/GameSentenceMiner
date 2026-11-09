# Portable profiles

Launch GSM with a folder to keep a separate set of settings and data:

```powershell
npm run start -- -profile "D:\GSM Profiles\Japanese"
npm run start -- -profile "D:\GSM Profiles\Korean"
```

Close the previous GSM instance before switching. Profiles use the existing network
ports; this feature is intended for running one instance at a time.

`--profile` and `--profile=PATH` also work. Paths may be absolute, relative to the
launch directory, or start with `~`. Quote paths containing spaces. A missing or
unusable folder argument is an error; GSM never falls back to another profile.
An absent folder is created automatically. Installed builds accept the same flag:

```powershell
& "C:\path\to\GameSentenceMiner.exe" -profile "D:\GSM Profiles\Japanese"
```

Each folder starts fresh and is reused on subsequent launches. It does not import
your normal settings or database. Launching without the flag returns to the normal
installation, including its previously selected data folder. A profile launch
does not change `data_dir.json`, the Windows data-directory registry entry, or
perform legacy database recovery. The Change Data Folder and Restore Original
Folder actions are unavailable in profile mode; change the launch argument instead.

## Profile contents

GSM-owned writable data stays under the selected folder:

- `config.json`, `gsm.db`, database/config backups, plugins, replacement rules,
  cloud-sync state, and game-specific configuration.
- `electron/`: desktop settings, Chromium storage/cookies/cache, window state,
  process records, and restart controls.
- `gsm_overlay/`: overlay settings, Yomitan/Hachidori dictionaries and browser
  storage. Dictionaries and their configuration are independent for each profile.
- `ocr_config/`, `owocr_config_gsm.ini`, OCR model choices, GPU preferences,
  text-hook game profiles, and Agent script settings/storage.
- `obs-studio/`: a separate managed OBS installation, including scenes, profiles,
  plugins, and settings. OBS portable mode keeps these beside its executable.
- `recordings/` and `recordings/Output/`: the default recording and media output
  locations; `logs/`, debug captures, `temp/`, and `downloads/` also stay here.

Paths explicitly selected in a profile's settings are still honored, including
custom recording/output paths and external tools. A profile does not relocate
external applications such as Anki, system OBS, or a browser opened outside GSM.
If using Google Vision's default credentials file, put `google_vision.json` in the
profile root. The home-directory credentials/configuration files are not imported.

## Shared installations

The managed `python_venv`, `uv`, FFmpeg, Ocenaudio, text-hook engine binaries,
Frida server, GPU support libraries, and Windows speech model/runtime downloads
are reused from the normal installation's data folder (including a relocated
installation). Installed engine/runtime version metadata belongs to those shared
installations; updating or repairing them affects every profile using them.
Per-game hook settings and selected OCR models remain profile-specific.

Bundled OCR/VAD models and existing system/Hugging Face/Torch/OneOCR/ScreenAI
model caches remain shared. VOCR also reuses downloaded native runtime/model files
while storing the selected model in the profile. User-installed dictionaries and
editable Agent scripts belong to the profile.

For development, `GSM_SHARED_DATA_DIR` can explicitly select a different shared
runtime root when launching with `-profile`. `GSM_PROFILE_DIR` is the equivalent
absolute-path environment override for direct Python/helper launches. The desktop
exports both variables plus `GSM_DATA_DIR` to its managed children automatically.

## Restarting during development

Normal restarts preserve the profile. To target it with the agent restart command:

```powershell
npm run agent:status -- --data-dir "D:\GSM Profiles\Japanese"
npm run agent:restart -- --data-dir "D:\GSM Profiles\Japanese" --handoff --reason "Changes ready to try"
```

Add `--build` when Electron changes have not already been built. See
[AGENT_RESTART.md](AGENT_RESTART.md) for the warning and restart workflow.
