# Removing Node from the desktop and build

## Completion target and remaining work

The target is a desktop that starts and runs without a Node service, a package
without a Node executable or production `node_modules`, and a build that does
not require a Node executable. Moving an operation behind a native forwarding
wrapper does not complete that operation's migration.

Current source still proves the overall migration is incomplete:

| Remaining ownership | Current source | Required end state |
| --- | --- | --- |
| Application startup, shutdown, restart, menus and installation coordination | `electron-src/main/main.ts`, `desktop-runtime/service.mjs`, `src-tauri/src/main.rs::start_services` | Tauri owns application lifetime without starting the compatibility service. |
| Python maintenance UI and application coordination | `main.ts`, `ui/python.ts`, update services | Native application coordination; backend preparation, launch, readiness, startup repair and restart now live in Rust, alongside package/version policy and setup-session state. |
| Desktop settings defaults, normalization and game launch automation | `electron-src/main/store.ts`, `ui/settings.ts`, `auto_launcher.ts`, game-launcher services | Native policies, typed commands and change events; preserve existing choices and profiles. |
| Reader/dictionary and overlay application coordination | `electron-src/main/services/reader*.ts`, `overlay_runtime.ts`, `GSM_Overlay/main.js`, `desktop-runtime/platform.cjs` | Browser UI plus native host services; no server-side JavaScript host. |
| Other application handlers and backend event dispatch | `services/main_ipc.ts`, remaining `ui/` modules, `main.ts` | Each retained feature has an explicit native owner; obsolete handlers are removed. |
| Package payload and launcher | `scripts/stage-native-desktop.mjs`, `desktop-runtime/`, `src-tauri/src/main.rs` | No Node download, executable, service launch, compiled main-process JS or production dependency tree. |
| Build, staging, release and development commands | `package.json`, `scripts/`, `.github/workflows/` | Documented commands succeed with Node absent from PATH; frontend asset compilation remains supported. |

Final verification must exercise a clean package with Node unavailable: startup,
existing settings/profiles, Python installation and restart, OBS/capture, text
hooking/Agent, OCR, text processing, speech, automation, reader/dictionaries,
overlay, updates and normal shutdown. Audit the generated payload as well as the
source. The current tests demonstrate individual migrations, not completion of
this full gate. Windows has local runtime coverage; Linux/macOS require their
own builds and runtime checks.

## Python installation and startup preparation

`gsm-packages::python` owns managed Python/uv installation, environment adoption,
dependency fingerprints, locked dependency synchronization, package metadata probes,
backend installation, tooling recovery and ONNX provider validation. Startup asks
Rust to prepare the environment; Node no longer decides whether the lockfile or
backend package needs installing. The existing Python version, uv version, extras,
post-release compatibility and fingerprint format are retained.

`gsm-packages::python::maintenance` now chooses compatible PyPI post releases,
skips network checks for local development builds, and performs complete backend
updates, explicit repairs, dependency resets and initialization-failure repairs.
It serializes each maintenance sequence, retries a failed update once after cache
cleanup, and permits one environment rebuild specifically for failed Python
tooling. Network/package conflicts do not trigger environment replacement.
Local version suffixes and newer compatible post releases are retained. Failed
maintenance finishes the native setup session even when the service is busy.

Custom package installation also uses the native task owner and leaves the
bundled project/lockfile intact. Python information, installed package listings
and cache cleanup use a typed Tauri command directly from the renderer. The
retired JavaScript backend-version policy is removed and excluded from stale
compiled package output. Backend update notifications originate in Tauri.

The application-service adapters still coordinate capture clients and request a
native backend launch after explicit maintenance; the GPU selection/reconnection
flow and app-update orchestration also remain there. These are outstanding migration work, not a
claim that update/repair actions are completely independent of Node yet.

The installer serializes writers across processes. An existing usable environment
is adopted in place. Rebuilding journals the operation and moves the old environment
to a retained backup before creating a replacement. Failure or an interrupted
transaction restores the previous environment. Downloaded uv archives are checked
against the pinned release's SHA-256, and extracted executables are verified before
activation. macOS retains the Homebrew Python workflow without globally removing
Homebrew Python. Settings, hook profiles and scripts are outside the installer.

`src-tauri/src/python_install.rs` coordinates installation with native managed
process launches. Preparation may reuse an unchanged environment while another
managed process is running; replacement and dependency changes require those
processes to stop. The native task runner owns each subprocess, output limit,
deadline and process tree. A busy compatibility service cannot block child output
readers or native progress events. Installer stage updates and output are recorded
directly in the native setup session, without application-service forwarding.

The TypeScript downloader and Python operation modules are temporary transport
adapters. The remaining application service still starts the setup UI, coordinates
explicit updates, and decides when to stop/relaunch other application components.
Those application flows remain work toward full Node removal.

`gsm-runtime::backend` and `src-tauri/src/backend.rs` own the complete backend
lifetime: prepare the environment, launch, observe authenticated readiness, repair
one initialization failure, relaunch, and stop/reap the owned process tree. A
stable lifetime ID spans startup recovery; stale stops cannot end a replacement.
Cancelling during preparation waits for the installer to reach a safe boundary
and prevents a late launch. Failure after successful initialization never invokes
package repair, including when a crash replacement cannot initialize. Each
spawn has a ten-minute readiness deadline; timeout stops the child without
assuming damaged dependencies. Failed cleanup prevents another launch.

The desktop's temporary `NativePythonProcess` adapter observes native events.
Backend restart is one native operation. Typed `backend_lifecycle` commands and
direct `backend-lifecycle` webview events also expose start/stop/restart/status
without the application service. Process logs are bounded when forwarding to a
busy compatibility client, and its pipe cannot hold up native runtime observers.
Installation results retain the original session attempt rather than borrowing
a later retry. Native engines remain running during startup package repair;
only native-owned Python process trees need to release that environment.

`node scripts/test-native-desktop.mjs backend` uses an isolated managed Python
installation and hidden webview to exercise an actually damaged backend package,
real repair, native readiness/restart/stop with Node busy, persistent startup
failure, stale stops, and unchanged settings/profile bytes. Native lifecycle unit
tests cover cancellation, duplicate launches, recovery limits and timeouts.

`gsm-packages::install_session` owns weighted progress, bounded diagnostic logs,
the active and most recent result, and retry attempt identities. Tauri publishes
coalesced session events directly to desktop windows and exposes a typed snapshot/
retry command. Renderer reloads can retrieve the latest result. Native Python
operations and backend progress/log/initialization events update this owner even
when Node is busy. Final diagnostics are written to `logs/install-session.log`;
session state is in memory and is not resumed across application restarts.

Retry claims are single-use and tied to the failed attempt. A temporary callback
adapter still runs the existing update/repair launch flow, acknowledges it before
the backend lifetime ends, and binds asynchronous failures to the claimed attempt.
A five-second dispatch timeout invalidates unaccepted claims, preventing a delayed
service request from launching work later. A claim already accepted by the service
remains valid even if its acknowledgement is delayed. Progress, result storage and retry bookkeeping
are native; retry **execution** still depends on application-service coordination.

`node scripts/test-native-desktop.mjs session` uses an isolated profile, hidden
webview and real Python worker to verify native progress/completion with Node busy,
direct renderer reads, duplicate retry rejection, expired dispatch rejection,
stale-attempt protection and preservation of existing settings/profile bytes.

Validation includes native installer/runner tests and
`node scripts/test-native-desktop.mjs python`. The latter creates a fresh temporary
shared directory, downloads and creates a real Python environment, installs uv,
checks native subprocess execution while Node is blocked, verifies direct Tauri
progress and active-process protection, and checks that fixture settings/profiles
are unchanged. It also compares native fingerprints against the previous Node
format. It does not install the full application dependency set in the user's
environment. macOS and Linux still require runtime verification on those platforms.

`cargo test --locked --manifest-path native/gsm-packages/Cargo.toml --test
python_maintenance -- --ignored --nocapture` runs the opt-in real maintenance
check. It creates an isolated environment/cache and small fixture project,
installs dependencies, damages an installed module, repairs it, resets dependency
files, exercises unchanged/forced updates, and verifies that settings, profiles,
the project manifest and lockfile are preserved. Normal native unit tests cover
release selection, bounded retries, and recovery decisions without network access.

## Text Processing and Windows Speech

`src-tauri/src/mining_workspace.rs` owns the workspace commands and native events.
The renderer invokes the typed `mining_workspace` command directly. Native runtime
events update the latest text and speech status/logs without a Node callback;
speech start/stop/status and settings reload commands go directly to the native
broker. Offline commands are not queued for later playback.

`gsm-settings::workspace` retains the existing text-processing section, per-scene
speech files and sentence-exclusion file. Reads do not rewrite settings. Writes
lock, re-read and atomically replace the affected document while preserving other
profiles and unknown fields. A damaged file fails instead of becoming defaults.
The text-processing edit is a narrow compatibility patch in the current Python
profile, not a migration of profile identities or a new public Python-shaped API.

`gsm-runtime::task` owns bounded one-shot jobs, input/output pipes, deadlines and
process-tree cleanup. Previews run the same Python processing module as before,
using the installed managed interpreter (or the development environment in a
debug build), without asking Node to find or start Python. Preview failures and
missing installation state are reported to the tab. Python still owns processing
and recognition algorithms; this migration removes their desktop Node dependency.

The old TypeScript handlers, latest-text cache and sentence-exclusion writer are
removed. Package policy rejects their stale compiler output. The Tauri check in
`node scripts/test-native-desktop.mjs tabs` rejects any attempt to call those old
Node handlers and verifies native work while the test service is blocked.

## Capture and OBS ownership

Capture-window discovery and requested previews run in Rust. Listing returns metadata
only; preview capture rechecks the window/process identity before and after acquiring
pixels. Windows previews are JPEGs bounded to 320×180. The renderer adapts these
backend-neutral identities to OBS selectors. Identical OBS selectors are combined,
without a misleading per-window image. Linux retains X11 and PipeWire source setup;
listing on Wayland never opens a capture portal.

All OBS implementation now belongs to the native host:

- `src-tauri/src/obs_service.rs`: OBS v5 authentication, request correlation,
  status codes, deadlines, events and connection teardown. Mutations are never replayed.
- `src-tauri/src/obs/mod.rs`: connection supervision, heartbeat, configuration,
  launch and safe output shutdown. `process.rs` verifies executable identity,
  shows OBS and requests graceful exit without process-name kills.
- `src-tauri/src/obs/config.rs`: current-profile configuration, portable config seeds,
  available WebSocket ports, atomic settings writes and retained settings snapshots.
- `src-tauri/src/obs/runtime.rs`: official stable release selection, SHA-256 download
  verification, safe extraction, OBS 33 core-module preservation, portable updates,
  rollback and recovery. Recording/streaming are checked before replacement; GSM's
  other capture clients are paused through an application maintenance hook.
- `src-tauri/src/obs/scenes.rs`: listing, selection, creation, renaming, removal,
  capture-mode changes, source metadata, scene previews, output probes and device
  enumeration. Temporary device inputs are released even on failure.
- `src-tauri/src/obs/switcher.rs`: legacy-rule migration, ECMAScript-style regular
  expressions, executable matching, manual holds, conflict selection and reconciliation.
  Native Windows foreground polling keeps this independent of the backend's input hook.

`src-tauri/src/desktop_services.rs` routes OBS and scene-switcher renderer requests
straight to Rust after desktop authorization. Disconnection never forwards them to
Node. The renderer cannot access service initialization or generic native RPC.

`electron-src/main/ui/obs.ts` is a compatibility client for application services
that still run in Node. It forwards requests and distributes native scene/install
notifications; it has no OBS sockets, retry timers, configuration parsing, process
control, scene policy, probing or updater implementation. The scene-switcher TS module
only forwards application notifications. The old Node implementations and the
`obs-websocket-js` dependency/adapter have been removed. Package checks reject stale
compiler output from those removed modules.

## Text hooking: native CLI sessions

`native/gsm-texthook` owns the entire live LunaHook/Textractor session: child
processes, UTF-16 pipe framing, hook enumeration/previews, saved-hook selection,
manual H/R-code commands, duplicate suppression, fragment buffering and timers,
architecture-mismatch retry, process identity/liveness, and shutdown. The actor
serializes lifecycle changes; old pipe readers carry a generation and cannot feed
a replacement session. Output lines, pipe queues, hook counts and samples are bounded.
Stopping flushes pending text once, requests detach, then reaps only the owned CLI;
it never terminates the game. Windows discovery, executable paths and architecture
queries use Win32 APIs rather than PowerShell or tasklist subprocesses.

`src-tauri/src/texthook.rs` exposes this through private service RPC. The renderer
still uses its existing authorized text-hook channels. `native_texthook.ts` is only
a transport; `texthook.ts` forwards native events and completed payloads to the
renderer and existing Python ingress without parsing or buffering CLI output.
Startup/download cancellation is checked before native attachment. Existing profiles,
settings and engine package paths remain compatible; no data migration is needed.

## Agent: native Frida sessions

`native/gsm-agent` now owns Agent attachment, the existing JavaScript loader,
synchronous script file access, local/session storage, initialization validation,
Unity retries, text buffering and delivery, script RPC and session teardown.
Scripts still run as JavaScript inside Frida; they do not require Node.

A separate Rust executable, `gsm-agent-host`, hosts Frida Core 17.16.4. Its C ABI
and official devkits are pinned, with verified SHA-256 downloads. Keeping the
helper separate avoids loading Frida's bundled GLib and C runtime into the Tauri
window process. Tauri links only the supervisor and protocol portion of the crate.
The helper has no Node or Electron child. Native build/staging scripts include
its matching executable and Frida licence notices.

The native supervisor owns helper launch, authenticated loopback control,
reconnection, cancellation, configuration and cached status. Detached sessions
survive GSM closing; attached sessions stop when their owning pipe closes.
Explicit Stop and update shutdown terminate the session without killing the game.
Existing local storage and the `texthook/agent-host.json` location are retained;
metadata uses protocol version 2. A previous version 1 host can be stopped through
its authenticated protocol on the first reconnect or before a new native session
starts; the log asks the user to start Agent again for this one-time migration. Inherited hosts
are never terminated based only on a persisted PID.

`src-tauri/src/agent.rs` owns the script control window and its session-scoped
`window.rpc` bridge. The window has no Node integration and cannot invoke the
general desktop API. Both local and detached TypeScript modules are now transport
facades; the old Node Agent host and its bootstrap path were removed. Stale compiled
host files are excluded from packages. The TextHookTab renderer is unchanged by
this migration.

Agent's optional Wine Frida bridge is also launched, downloaded, decompressed and
owned by Rust. Wine/Proton launch-context discovery still belongs to the shared
application service. The built-in engines are now retired (see below); npm Frida
is development-only for their preserved source. Hook packages, profile persistence,
update coordination and Python text ingress have native owners.

## Existing settings

Rust imports `autoUpdateOBS` and `windowSceneSwitcher` once from the existing
`electron/config.json` into `<data directory>/obs-service.json`. The original file
is preserved. Subsequent OBS settings writes use the native file, avoiding races
with the application's general settings store. Python's current-profile OBS settings
remain in `<data directory>/config.json`. OBS's portable profiles, scenes and plugins
keep their existing locations; snapshots also include the native settings file.

Legacy OBS switching rules are persisted before the legacy switcher is disabled.
An active recording or stream defers the restart needed to migrate an already-running
OBS instance. Failed scene enumeration never prunes saved rules.

## What still requires Node

The desktop still starts the Node compatibility service. This is not a Node-free
application yet. The remaining work is application orchestration rather than the
live OBS, Agent, CLI hook, Python supervisor, or message-bus implementations.

| Remaining area | Current owners | Native destination |
| --- | --- | --- |
| Startup/setup UI, update/repair launch coordination and GPU selection UI | `main.ts`, update services, `gpu_install.ts`, `ui/python.ts` | Native application ownership; installation, dependency operations, startup preparation and session state already run in Rust |
| Game launching, auto-attach, Wine/Proton discovery and scene-launch policy | `auto_launcher.ts`, `services/game_launcher*.ts`, target selection in `ui/texthook.ts` | Native launcher state and platform adapters |
| Preference defaults, normalization and feature side effects | `store.ts`, `ui/settings.ts`, `services/main_ipc.ts` | Typed feature commands backed by the existing native preference store |
| Reader/dictionary and overlay application coordination | `services/reader*.ts`, `shared_dictionary_engine.ts`, `ui/overlay.ts`, `overlay_runtime.ts` | Tauri window/service ownership and scoped events |
| Remaining desktop shell flows | `main.ts`, UI modules, update/restart coordination, backup/data relocation | Tauri-managed startup, tray/windows, lifecycle and services |

Startup/shutdown requests and capture-client maintenance call the native OBS owner;
they do not provide an OBS fallback. The final cutover must replace the remaining
`Host` request forwarding and window/lifecycle orchestration before removing
`start_services`, `desktop-runtime/service.mjs`, the bundled Node binary and runtime
npm dependencies. Current build tooling still uses npm/Vite; replacing that Node
requirement is also part of the completion target. Frontend TypeScript runs in
the webview and does not need a Node process in the installed application.

## References

Kimochi's [Windows source catalog](https://github.com/hamstu/kimochi/blob/main/src-tauri/src/platform/windows/sources.rs)
provided ideas for separating metadata discovery from acquisition and checking process
identity. GSM retains its existing xcap/WGC capture implementation. Selector escaping
follows [OBS's implementation](https://github.com/obsproject/obs-studio/blob/master/plugins/win-capture/audio-helpers.c).

## Verification

```powershell
npm run build
npx tsc --noEmit -p electron-src/renderer/tsconfig.json
npx vitest run electron-src/main/ui/obs.test.ts electron-src/main/services/window_scene_switcher.test.ts electron-src/main/auto_launcher.test.ts electron-src/shared/capture_window_policy.test.ts electron-src/renderer/src/lib/captureTargets.test.ts electron-src/renderer/src/components/SceneSwitcherSettings.test.tsx electron-src/renderer/src/components/tabs/CaptureTargetPicker.test.tsx electron-src/renderer/src/components/tabs/HomeTab.test.tsx
node --test scripts/native-package-policy.test.mjs
cargo test --locked --manifest-path src-tauri/Cargo.toml --target-dir src-tauri/target/native-dev --bin gsm-desktop -- --test-threads=1
node scripts/build-native-dev.mjs
node scripts/test-native-services.mjs
```

The isolated desktop test uses a fake OBS server and a separate real native window.
Tripwire Node handlers cover direct routing, scene operations, capture modes, previews,
saved rules, devices, failed-probe cleanup, automatic reconnect and authorization.
Rust tests cover protocol failures, profile selection, settings migration, snapshots,
version policy, download origin/checksum requirements, extraction safety, rollback
swaps/recovery, plugin preservation, capture plans and rule semantics. These checks
do not perform an update against the user's real OBS installation. macOS/Linux runtime
behavior still needs testing on those operating systems.

### Text-hook verification

```powershell
cargo test --locked --manifest-path native/gsm-texthook/Cargo.toml
cargo build --locked --manifest-path native/gsm-texthook/Cargo.toml --examples
native/gsm-texthook/target/debug/examples/injection_smoke.exe electron-src/assets/texthook native/gsm-texthook/target/debug/examples/text_target.exe
# With the i686-pc-windows-msvc Rust target installed:
cargo build --locked --manifest-path native/gsm-texthook/Cargo.toml --example text_target --target i686-pc-windows-msvc
native/gsm-texthook/target/debug/examples/injection_smoke.exe electron-src/assets/texthook native/gsm-texthook/target/i686-pc-windows-msvc/debug/examples/text_target.exe
# After build:main and the native desktop build:
node scripts/test-native-desktop.mjs texthook
node scripts/test-native-desktop.mjs workspace
node --test desktop-runtime/tests/*.test.cjs
```

The injection driver and disposable GDI target are Rust executables. They exercise
real engine injection, Japanese/emoji text, previews, hook selection, rejection of
concurrent starts, stop/reattach and target exit without a Node process. The Tauri
smoke test separately verifies real private RPC, native process discovery and event
delivery through the production transport. All targets belong to the test; no running
game is touched. Textractor x64's generic TextOutW hook interprets the fixture's
pointer as a character, so that case explicitly uses `HQN-54@0:gdi32.dll:TextOutW`
to exercise the manual string-hook path. This is a test-specific hook, not a default
in production. Parser tests cover split UTF-16 units/surrogates, multiline/status
boundaries, oversized lines, quote backlogs, cumulative fragments, redraw suppression,
profile matching, bounded samples and timer changes. Linux/Wine runtime still needs
verification on a Linux machine.

### Agent verification

```powershell
cargo test --locked --manifest-path native/gsm-agent/Cargo.toml
cargo build --locked --manifest-path native/gsm-agent/Cargo.toml --examples
# Pass an owned text_target.exe PID to loader_probe.exe / host_probe.exe.
# With both x64 and i686 text_target.exe fixtures built as described above:
node scripts/build-native-dev.mjs
npm run build:main
node scripts/test-native-desktop.mjs agent
```

The native probes require an installed Agent script library at `.agent_scripts`
(including `libLoader.js` and its companion libraries). They exercise the real
loader, Unicode text, persisted storage,
script RPC, detached survival after the parent process exits, reconnection,
rejection of stale sessions/incorrect credentials, attached shutdown, slow initialization
and cancellation during Unity retries. The Tauri smoke checks both x64 and x86
fixture processes, the actual script window and its RPC/events, binary replies,
startup errors and buffered text on Stop. It checks that the helper has no Node
child and that Stop leaves each target alive. These checks use disposable fixtures,
not the user's game. macOS and Linux/Wine require runtime verification on those
platforms.

To verify a normal game session, select Agent and its existing script, then start
hooking. The log reports `Agent runtime: native Rust / Frida 17.16.4`. Status moves
from starting to waiting, then receiving when dialogue is captured. Script controls
and detached reconnection use the same existing buttons. `texthook/agent-host.log`
contains native startup/connection failures if the helper cannot initialize.


## Retired built-in hooks, native Wine bridge, and Python runtime

The experimental built-in engine-hook entry is hidden and cannot be started by
IPC or the auto-launcher. Existing `mages` profiles remain on disk; opening one
presents the available engines without rewriting the saved profile. The source
under `electron-src/main/engine_hooks`, the injected support scripts, and all
existing documentation remain available for a future redesign. The archived
runtime and `ui/wine_frida` are excluded from application resources. Node's Frida
package is development-only for the preserved source/tests, and is forbidden in
the production package.

LunaHook/Textractor's remaining Wine PID lookup now uses `gsm-agent-host
--gsm-wine-bridge`. It starts the pinned, checksum-verified Windows Frida server
inside the captured Wine/Proton environment, resolves the executable's Windows
PID, then releases the temporary bridge. Duplicate executable names are rejected
instead of guessing a target. The native desktop owns cancellation and the helper's
parent-pipe lease. `GSM_FRIDA_SERVER_X86_PATH` / `GSM_FRIDA_SERVER_X64_PATH` overrides
remain supported. No Node Frida device or server process participates in capture.
Linux Wine/Proton still needs an end-to-end check on a Linux machine.

`native/gsm-runtime` is linked into Tauri and now owns:

- The loopback WebSocket broker, handshake deadlines, per-connection identity,
  routing, bounded queues, request correlation and timeout/disconnect failures.
- Python backend and compatibility OCR process launch, readiness, graceful stop,
  escalation, worker cleanup, and runtime crash recovery.
- The acknowledged text outbox: at most 256 observations, stable observation IDs,
  retries across backend restarts, capture-order preservation under backpressure,
  and explicit admission errors when full.

Windows children start suspended until assigned to a kill-on-close job, so their
workers are owned from the first instruction. Virtual-environment redirectors are
supported: the interpreter must belong to that job and present the token generated
for its launch. Unix children have their own process groups. Native shutdown reaps
owned workers before allowing a replacement; it does not scan process names or
kill bare PIDs loaded from old tracking files.

An initialized backend may restart three times within 60 seconds, with a one-second
delay. A fourth crash ends that lifetime. Initialization failures are returned to
the existing installation/repair flow. Manual stops cancel pending restarts.
The legacy `GSM_ELECTRON` environment marker remains for Python compatibility; it
does not imply an Electron or Node supervisor.

The Python wire envelope stays at version 1 for compatibility with installed
backends. The Python client now waits for the welcome before reporting connected,
limits frame size, and fails pending requests when disconnected. Each managed
launch gets a fresh token; the general bus credential cannot impersonate it.
Ordinary commands are no longer replayed when an offline recipient reconnects.
The native text outbox is the explicit retry mechanism for captured text.

Agent and CLI hook output goes directly from their native controllers into the
native outbox and Python. Acknowledged, processed text returns as a renderer
preview event. Node's `message_bus`, `process_manager`, `native_python`, and
`text_ingress` modules are compatibility clients for remaining application/UI
handlers. They contain no broker, child launch/kill, lifecycle timers, crash retry
loop, or text retry queue. Python installation and package-repair operations are
still coordinated by the application service.

### Runtime verification

```powershell
cargo test --locked --manifest-path native/gsm-runtime/Cargo.toml
cargo test --locked --manifest-path native/gsm-agent/Cargo.toml
.venv/Scripts/python.exe -m pytest tests/util/test_bus_client.py tests/concurrency/test_text_ingress_outbox.py -q
npm run build
node scripts/build-native-dev.mjs
node scripts/test-native-desktop.mjs runtime
node scripts/test-native-desktop.mjs agent
node scripts/test-native-desktop.mjs texthook
```

The runtime desktop check starts a disposable Python backend using the actual
`BusClient`, verifies requests in both directions and text delivery while Node's
event loop is blocked, exercises the crash limit, then checks graceful shutdown.
The Agent and CLI checks additionally deliver real hooked Japanese/emoji text to
that Python client directly, without a Node forwarding callback. Agent stop-flush
is checked through the native outbox as well. All checks use isolated profiles and
owned fixture targets. Windows has been exercised locally; Linux/macOS process
and Wine behavior require platform runtime verification.

The workspace check loads the real reader, settings, and tray after starting the
native broker. A transport regression test covers Windows standard-input
initialization before the pipe worker starts reading, so later `node:process`
imports cannot deadlock desktop startup.

## Native settings foundation and hook packages

The gsm-settings crate resolves the active and shared data roots before the Node
service starts. It retains the existing bootstrap pointer, isolated profile
folders, and legacy database-migration marker. The desktop passes those resolved
roots to its compatibility service rather than independently selecting a folder.

Hook profiles stay in texthook/profiles.json, with the existing executable and
scene keys. Reads do not rewrite the document. Edits take a cross-process file
lock, re-read the latest document, merge only the requested profile, and publish
flushed bytes with an atomic replacement. Other profiles, unknown fields,
unrecognized entries, and hidden mages profiles survive. Invalid JSON produces
an error instead of being replaced by an empty configuration.

This is a persistence foundation, not the future application-profile schema.
Python still owns its mining configuration schema and current profile selection;
native text-processing edits now patch only that selected profile's processing
section. Future profile work should introduce explicit identities and
separate game associations from reusable capture/mining preferences, with a
versioned migration and preserved originals. Avoid copying Python's nested
configs/current_profile representation into the native public API or adding
another independent writer to Python's file.

The gsm-packages crate owns LunaHook/Textractor catalog requests, downloads,
SHA-256 checks, archive validation, repair/version selection, staged generations,
and atomic activation. Existing loose installations and versioned package
pointers remain readable. Automatic downgrades are rejected; deliberate version
selection is supported. Preparation never changes the active installation, and
activation rechecks every file after any wait. Prepared packages are represented
by native-owned tokens at the service boundary. Previous generations are retained.

The same crate owns managed Agent-library updates. Upstream-owned hashes identify
files that may be replaced; custom/modified files are preserved and excluded from
future updater ownership. Older installations without hashes are compared against
their pinned upstream commit where available. An interrupted directory/metadata
switch is recovered through a transaction journal. Previous script trees are kept
as recovery material. If a local link cannot be reproduced, the update fails
without replacing the current library.

The TypeScript facades contain no package downloading/extraction or profile file
writes. Agent script execution remains JavaScript inside native Frida.

### Desktop preferences and native update coordination

`gsm-settings::preferences` now owns desktop preference persistence in the existing
`electron/config.json`. It applies narrow patches under the same cross-process lock
and atomic replacement used for hook profiles. Unknown keys are preserved, and
invalid documents cannot be silently replaced. Defaults are supplied as a read
view rather than written during reads. Python's desktop preference view is read-only
and no longer writes merged defaults on load/reload; Python mining profiles remain
untouched. `desktop-runtime/store.mjs` is a compatibility client with no file cache
or independent writer. The production `conf` dependency is removed.

`desktop-runtime/preferences.cjs` shares one native snapshot during the synchronous
portion of an IPC handler, discarding it on writes, return, or await. Visible-tab
changes are broadcast instead of polling the full settings document. The bridge
reuses its completed synchronous response buffer and discards timed-out buffers.

`gsm-packages::updates::Updater` owns six-hour checks, progress, staged packages,
automatic-update preferences and idle activation. Tauri starts its scheduler.
Native attachment reservations cover target discovery and native starts; activation
requires an idle controller and excludes new attachments until verification and
the package switch finish. Explicit version selection pins automatic updates off.
Disabling automatic updates discards a queued automatic package. Errors preserve
the installed generation and allow retry; offline checks return a complete UI state.

The React text-hook profile and update controls invoke typed `hook_profiles` and
`hook_updates` Tauri commands directly. Update notifications use Tauri events.
These commands require a trusted desktop window and its nonce; generic preference
and package RPC stays private. The Node update facade contains no scheduler or
package lifetime. The old TypeScript coordinator is removed, its behavior tests
now exercise the native service, and stale compiled output is excluded from packages.

Verification:

~~~powershell
cargo test --locked --manifest-path native/gsm-settings/Cargo.toml
cargo test --locked --manifest-path native/gsm-packages/Cargo.toml
node scripts/test-native-desktop.mjs foundation
node scripts/test-native-desktop.mjs workspace
node scripts/test-native-desktop.mjs tabs
node scripts/test-native-desktop.mjs texthook
node scripts/test-native-desktop.mjs agent
~~~

Package tests use local HTTP fixtures and real ZIP files. They cover corruption,
unsafe archives, deliberate downgrade, stale automatic activation, incomplete
installation repair, failed pointer replacement, local Agent edits, offline use,
and interrupted-update recovery. The foundation desktop check exercises the
actual Rust/TypeScript boundary, byte-preserving reads, targeted preference edits,
and direct profile commands/update events while Node's event loop is deliberately
blocked. Python mining configuration remains byte-for-byte unchanged. Updater
tests cover native idle polling, attachment exclusion and offline UI state as well.
These desktop checks have been run on Windows; other
platforms still require runtime verification.
