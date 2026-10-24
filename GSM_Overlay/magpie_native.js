// Magpie's documented window properties/broadcasts, plus its cursor capture
// state. See docs/MAGPIE_COMPATIBILITY.md for the versioned upstream evidence.
const { normalizeMagpieInfo } = require('./magpie');
const SCALING_CLASS = 'Window_Magpie_967EB565-6F73-4E94-AE53-00CC42592A22';

function handleValue(buffer) {
  return buffer.length >= 8 ? buffer.readBigUInt64LE() : BigInt(buffer.readUInt32LE());
}

function createMagpieNative() {
  if (process.platform !== 'win32') return null;
  const koffi = require('koffi');
  const lib = koffi.load('user32.dll');
  const f = {
    find: lib.func('uintptr_t __stdcall FindWindowW(str16 className, str16 title)'),
    visible: lib.func('int __stdcall IsWindowVisible(uintptr_t hwnd)'),
    prop: lib.func('uintptr_t __stdcall GetPropW(uintptr_t hwnd, str16 name)'),
    foreground: lib.func('uintptr_t __stdcall GetForegroundWindow()'),
    style: lib.func('long __stdcall GetWindowLongW(uintptr_t hwnd, int index)'),
    cursor: lib.func('int __stdcall GetPhysicalCursorPos(void *point)'),
    key: lib.func('short __stdcall GetAsyncKeyState(int key)'),
    message: lib.func('uint32 __stdcall RegisterWindowMessageW(str16 name)'),
    filter: lib.func('int __stdcall ChangeWindowMessageFilterEx(uintptr_t hwnd, uint32 message, uint32 action, void *change)'),
  };
  const message = f.message('MagpieScalingChanged');
  if (!message) throw new Error('RegisterWindowMessageW failed');

  function read(expectedSource) {
    if (!expectedSource) return null;
    const hwnd = f.find(SCALING_CLASS, null);
    if (!hwnd || !f.visible(hwnd)) return null;
    const source = Number(f.prop(hwnd, 'Magpie.SrcHWND'));
    if (source !== Number(expectedSource)) return null;
    const info = { source_hwnd: source, scaling_hwnd: Number(hwnd), windowed: !!f.prop(hwnd, 'Magpie.Windowed') };
    for (const [prefix, nativePrefix] of [['sourceWindow', 'Src'], ['magpieWindow', 'Dest']]) {
      for (const edge of ['Left', 'Top', 'Right', 'Bottom']) {
        // Magpie casts signed LONG coordinates to pointer-sized HANDLEs.
        info[`${prefix}${edge}EdgePosition`] = Number(BigInt.asIntN(32, BigInt(f.prop(hwnd, `Magpie.${nativePrefix}${edge}`))));
      }
    }
    if (!f.visible(hwnd) || Number(f.prop(hwnd, 'Magpie.SrcHWND')) !== source) return null;
    const normalized = normalizeMagpieInfo(info);
    return normalized ? { ...normalized, source_focused: Number(f.foreground()) === source } : null;
  }

  return {
    read,
    watch(win, callback) {
      const hwnd = handleValue(win.getNativeWindowHandle());
      // Permit just this registered message when GSM has higher integrity.
      if (!f.filter(hwnd, message, 1, null)) console.warn('[Magpie] Could not allow scaling notifications through UIPI');
      win.hookWindowMessage(message, (wParam, lParam) => callback(Number(handleValue(wParam)), Number(handleValue(lParam))));
      return () => { if (!win.isDestroyed()) win.unhookWindowMessage(message); };
    },
    cursor(info) {
      const hwnd = info.scaling_hwnd;
      if (!hwnd || !f.visible(hwnd) || Number(f.prop(hwnd, 'Magpie.SrcHWND')) !== info.source_hwnd) return null;
      const point = Buffer.alloc(8); // POINT is two signed 32-bit LONGs.
      if (!f.cursor(point)) return null;
      // CursorManager sets WS_EX_TRANSPARENT while passing input to the source
      // and clears it when relinquishing capture to an overlapping window.
      const down = key => !!(f.key(key) & 0x8000);
      return { x: point.readInt32LE(0), y: point.readInt32LE(4), captured: !!(f.style(hwnd, -20) & 0x20),
        buttons: (down(1) ? 1 : 0) | (down(2) ? 2 : 0) | (down(4) ? 4 : 0) | (down(5) ? 8 : 0) | (down(6) ? 16 : 0),
        shiftKey: down(0x10), ctrlKey: down(0x11), altKey: down(0x12), metaKey: down(0x5b) || down(0x5c) };
    },
  };
}

module.exports = { createMagpieNative, handleValue };
