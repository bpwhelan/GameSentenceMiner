const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { between } = require('./helpers/overlay-startup.cjs');

const source = fs.readFileSync(path.join(__dirname, '../main.js'), 'utf8');

function fixture(overrides = {}) {
  const changes = [];
  const ipcMain = new EventEmitter();
  const context = vm.createContext({
    ipcMain, console: { log() {}, warn() {} }, Date,
    mainWindow: { setIgnoreMouseEvents: ignore => changes.push(ignore) },
    canUseOverlayCapture: () => true,
    isManualMode: () => false,
    isWindows: () => true, isMac: () => false,
    isYomitanStateLikelyStale: () => false,
    manualHotkeyPressed: false, manualModeToggleState: false,
    gamepadNavigationActive: false, resizeMode: false,
    yomitanShown: false, yomitanRecoveryVersion: 0, lastYomitanEventAt: Date.now(),
    ...overrides,
  });
  vm.runInContext(between(source, "  ipcMain.on('set-ignore-mouse-events'", '  ipcMain.on("hide"'), context);
  return {
    changes, context,
    release: () => ipcMain.emit('set-ignore-mouse-events', {}, true, { forward: true, forceMagpieRelease: true }),
  };
}

for (const activeInteraction of [
  'yomitanShown', 'manualHotkeyPressed', 'manualModeToggleState', 'gamepadNavigationActive', 'resizeMode',
]) {
  test(`a queued Magpie release preserves ${activeInteraction}`, () => {
    const { changes, release } = fixture({ [activeInteraction]: true });
    release();
    assert.deepEqual(changes, []);
  });
}

test('Magpie still recovers a stale dictionary state and releases ordinary hover capture', () => {
  const { changes, context, release } = fixture({
    yomitanShown: true, isYomitanStateLikelyStale: () => true,
  });
  release();
  assert.equal(context.yomitanShown, false);
  assert.deepEqual(changes, [true]);
});

test('a stale popup does not cancel an active controller interaction', () => {
  const { changes, context, release } = fixture({
    yomitanShown: true, gamepadNavigationActive: true, isYomitanStateLikelyStale: () => true,
  });
  release();
  assert.equal(context.yomitanShown, true);
  assert.deepEqual(changes, []);
});
