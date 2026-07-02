// Windows foreground assertion via AttachThreadInput.
//
// Electron's BrowserWindow.show()/focus() cannot steal foreground from a
// fullscreen game when invoked outside a WM_HOTKEY context — e.g. when a hotkey
// is routed through the input server and the handler fires from a websocket
// callback. Windows' foreground lock refuses activation from a "background"
// process, so the overlay raises z-order (alwaysOnTop) but the game keeps
// keyboard focus.
//
// AttachThreadInput temporarily shares the foreground (game) thread's input queue
// with the thread that owns the overlay window, which makes SetForegroundWindow
// succeed deterministically rather than asking permission. This must run on the
// thread that owns the window — Electron's main thread.

let initialized = false;
let available = false;
let fns = null;

function init() {
  if (initialized) return available;
  initialized = true;
  if (process.platform !== "win32") return false;
  try {
    const koffi = require("koffi");
    const user32 = koffi.load("user32.dll");
    const kernel32 = koffi.load("kernel32.dll");
    fns = {
      GetForegroundWindow: user32.func("void* GetForegroundWindow()"),
      GetWindowThreadProcessId: user32.func(
        "uint32 GetWindowThreadProcessId(void* hWnd, void* lpdwProcessId)"
      ),
      AttachThreadInput: user32.func(
        "int AttachThreadInput(uint32 idAttach, uint32 idAttachTo, int fAttach)"
      ),
      SetForegroundWindow: user32.func("int SetForegroundWindow(void* hWnd)"),
      BringWindowToTop: user32.func("int BringWindowToTop(void* hWnd)"),
      GetCurrentThreadId: kernel32.func("uint32 GetCurrentThreadId()"),
    };
    available = true;
  } catch (e) {
    console.warn(
      "[Foreground] koffi unavailable; falling back to Electron focus only:",
      e.message
    );
    available = false;
  }
  return available;
}

// getNativeWindowHandle() returns a Buffer holding the HWND; koffi takes the raw
// address (BigInt) for a void* argument.
function hwndAddressFromHandle(handle) {
  if (!handle || handle.length === 0) return 0n;
  return handle.length >= 8
    ? handle.readBigUInt64LE(0)
    : BigInt(handle.readUInt32LE(0));
}

// Force the given BrowserWindow to the foreground. The window must already be
// visible (SetForegroundWindow no-ops on hidden windows), so callers should
// show()/showInactive() first. Returns true if the native path ran (not a
// guarantee the OS honored it); false if unavailable so callers keep their
// existing focus() fallback.
function forceForegroundWindow(win) {
  if (!win || win.isDestroyed()) return false;
  if (!init()) return false;

  let hwnd;
  try {
    hwnd = hwndAddressFromHandle(win.getNativeWindowHandle());
  } catch (e) {
    return false;
  }
  if (!hwnd) return false;

  const {
    GetForegroundWindow,
    GetWindowThreadProcessId,
    AttachThreadInput,
    SetForegroundWindow,
    BringWindowToTop,
    GetCurrentThreadId,
  } = fns;

  let attached = false;
  let fgThread = 0;
  let ourThread = 0;
  try {
    const fg = GetForegroundWindow();
    fgThread = GetWindowThreadProcessId(fg, null);
    ourThread = GetCurrentThreadId();
    // Already foreground on our own thread — nothing to attach.
    if (fgThread && fgThread !== ourThread) {
      attached = !!AttachThreadInput(ourThread, fgThread, 1);
    }
    BringWindowToTop(hwnd);
    SetForegroundWindow(hwnd);
    return true;
  } catch (e) {
    console.warn("[Foreground] forceForegroundWindow failed:", e.message);
    return false;
  } finally {
    if (attached) {
      try {
        AttachThreadInput(ourThread, fgThread, 0);
      } catch (e) {
        /* detach best-effort */
      }
    }
  }
}

module.exports = { forceForegroundWindow };
