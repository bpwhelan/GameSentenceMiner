# Restarting GSM after agent changes

Agents can request a full desktop restart, including GSM's backend and managed
helpers, through the running app's authenticated local message bus.

Start GSM once with this feature included (`npm start`). Subsequent agent changes
can use the command below from the repository root:

```powershell
npm run agent:restart -- --build --reason "The OCR fix is ready to try"
```

`--build` builds the Electron main process and renderer before asking GSM to
restart. If the build fails, the running app is left alone. Omit `--build` for
Python-only changes or when the necessary assets have already been built:

```powershell
npm run agent:restart -- --reason "The backend fix is ready to try"
```

The command:

1. Checks the running GSM instance and refuses to interrupt an update or installation.
2. Shows a desktop notification explaining the reason and waits 30 seconds by default.
   On Windows and macOS, choose **Restart Now** in the notification to restart early.
3. Runs the normal shutdown cleanup, waiting for the backend, OCR, overlay,
   input service, and other managed processes. A cleanup failure prevents relaunch.
4. Relaunches the same app with its original arguments and normal startup settings.
5. Waits for the matching new app instance and its backend to be ready, then prints
   confirmation. GSM also shows a ready notification.

The exit code is zero only after readiness is confirmed. Failures and timeouts
return a nonzero code; check the message and GSM logs before retrying. A timeout
does not kill the replacement app. Concurrent requests share one warning and
restart. If desktop notifications cannot be delivered, GSM stays running.

```powershell
npm run agent:status
npm run agent:restart -- --delay 10 --timeout 180 --reason "New overlay behavior"
npm run agent:restart -- --help
```

`--delay` accepts 5–300 seconds (30 by default). `--timeout` includes the countdown and startup
(120 seconds by default). `--data-dir "C:\path\to\GSM-data"` overrides discovery;
normally the command resolves GSM's relocated data directory automatically.

Use `npm start` for this workflow. `npm run dev` owns a watcher-driven restart loop
and is deliberately rejected, since rebuilding watched files could otherwise
restart Electron before the warning. Manually started tools follow their normal
startup settings; this command does not promise to restore an unsaved UI session.
An independently launched overlay or other tool is outside the main app's managed
processes and must be restarted separately when its code changes.

The command does not sync or build Yomitan, regenerate Hachidori, or compile Rust
helpers. Follow the relevant repository workflows first. `--build` only targets a
development app running from this checkout; it will not claim local changes were
loaded by an installed or different copy of GSM.

## Local protocol

The running desktop publishes `<GSM data directory>/electron/agent-control.json`
with an instance ID, PID, app path, and the current loopback message-bus connection.
This file contains a per-launch credential: do not print it or commit it. Status
output intentionally omits the credential. No public HTTP control endpoint is added.

Authenticated bus requests to `main` use `app.agent.status` and `app.agent.restart`.
Restart accepts `{ "reason": "Changes ready", "delaySeconds": 30 }` and replies with
`requestId`, `restartAt`, and `reason`. Readiness must come from a **different**
instance whose `restartId` matches that request. The provided command handles
discovery, authentication, acknowledgements, and readiness checks.
