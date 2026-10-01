const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const renderer = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');

function fixture() {
  const scripts = [], instances = [], listeners = new Map();
  class Handler {
    constructor(config) { this.config = config; this.destroyed = false; this.toggles = 0; instances.push(this); }
    destroy() { this.destroyed = true; }
    updateConfig(config) { this.config = config; }
    setTokenMode() {}
    manualDeactivate() {}
    manualToggle() { this.toggles++; }
  }
  const context = vm.createContext({
    window: { addEventListener() {} },
    document: {
      createElement: () => ({ remove() { this.removed = true; } }),
      head: { appendChild: script => scripts.push(script) },
      getElementById: () => null,
    },
    ipcRenderer: { send() {}, on: (event, listener) => listeners.set(event, listener) },
    console: { log() {}, error() {} }, setTimeout, clearTimeout,
    showFurigana: false, dictionaryReader: 'yomitan',
    pendingManualRevealForBackground: false, isManualInteractionSuppressed: () => false,
  });
  const start = renderer.indexOf('  let gamepadHandler = null;');
  const end = renderer.indexOf('\n</script>', start);
  assert(start >= 0 && end > start);
  vm.runInContext(renderer.slice(start, end), context);
  return {
    scripts, instances, listeners, context,
    run: code => vm.runInContext(code, context),
    load(index = scripts.length - 1) { context.window.GamepadHandler = Handler; scripts[index].onload(); },
  };
}

test('concurrent initialization shares one handler with the latest settings', async () => {
  const f = fixture();
  const first = f.run('initGamepad()');
  const second = f.run('gamepadSettings.tokenMode = true; syncGamepadHandlerLifecycle()');
  assert.equal(f.scripts.length, 1);
  f.load();
  await Promise.all([first, second]);
  assert.equal(f.instances.length, 1);
  assert.equal(f.instances[0].config.tokenMode, true);
  assert.equal(f.instances[0].destroyed, false);
});

test('disabling navigation while its script loads does not create a handler', async () => {
  const f = fixture();
  const pending = f.run('initGamepad()');
  await f.run('gamepadSettings.enabled = false; syncGamepadHandlerLifecycle()');
  f.load();
  await pending;
  assert.equal(f.instances.length, 0);
  assert.equal(f.context.window.gamepadHandler, null);
});

test('failed lazy loads can be retried without keeping the failed script', async () => {
  const f = fixture();
  const first = f.run('initGamepad()');
  f.scripts[0].onerror();
  await first;
  const second = f.run('initGamepad()');
  assert.equal(f.scripts.length, 2);
  assert.equal(f.scripts[0].removed, true);
  f.load();
  await second;
  assert.equal(f.instances.length, 1);
});

test('repeated settings snapshots preserve the active handler', async () => {
  const f = fixture();
  const first = f.run('initGamepad()');
  f.load();
  await first;
  const original = f.context.window.gamepadHandler;
  await f.run('gamepadSettings.repeatRate = 200; initGamepad()');
  assert.equal(f.context.window.gamepadHandler, original);
  assert.equal(original.config.repeatRate, 200);
  assert.equal(original.destroyed, false);
});

test('a hotkey retry is acknowledged only after its toggle can be handled', async () => {
  const f = fixture();
  const toggle = f.listeners.get('gamepad-toggle-navigation');
  toggle(null, { requestId: 'first' });
  const pending = f.run('initGamepad()');
  f.load();
  await pending;
  toggle(null, { requestId: 'first' });
  toggle(null, { requestId: 'first' });
  assert.equal(f.instances[0].toggles, 1);
});

test('a hotkey delivered during initialization is applied once when loading finishes', async () => {
  const f = fixture();
  const pending = f.run('initGamepad()');
  const toggle = f.listeners.get('gamepad-toggle-navigation');
  const first = toggle(null, { requestId: 'during-load' });
  const retry = toggle(null, { requestId: 'during-load' });
  f.load();
  await Promise.all([pending, first, retry]);
  assert.equal(f.instances.length, 1);
  assert.equal(f.instances[0].toggles, 1);
});
