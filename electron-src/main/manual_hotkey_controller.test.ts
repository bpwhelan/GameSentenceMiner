import { createRequire } from 'module';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const {
  MANUAL_HOTKEY_BACKEND_ELECTRON,
  MANUAL_HOTKEY_BACKEND_INPUT_SERVER,
  MANUAL_HOTKEY_MODE_HOLD,
  MANUAL_HOTKEY_MODE_TOGGLE,
  createManualHotkeyController,
  resolveManualHotkeyBackend,
} = require('../../GSM_Overlay/manual_hotkey_controller.js');

type Snapshot = {
  keyDown: boolean;
  pendingTap: boolean;
  holdActive: boolean;
  toggleLatched: boolean;
  isActive: boolean;
};

type EventRecord = {
  snapshot: Snapshot;
  source: string;
  reason: string;
};

function createHarness() {
  const events: EventRecord[] = [];
  let mode = MANUAL_HOTKEY_MODE_HOLD;
  const controller = createManualHotkeyController({
    holdReleaseTimeoutMs: 650,
    getMode: () => mode,
    onStateChange(snapshot: Snapshot, meta: { source: string; reason: string }) {
      events.push({
        snapshot: { ...snapshot },
        source: meta.source,
        reason: meta.reason,
      });
    },
  });

  return {
    controller,
    events,
    setMode(nextMode: string) {
      mode = nextMode;
    },
    getLastEvent() {
      return events[events.length - 1];
    },
  };
}

describe('manual_hotkey_controller', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('toggle mode toggles on and off across separate presses', () => {
    const harness = createHarness();
    harness.setMode(MANUAL_HOTKEY_MODE_TOGGLE);

    harness.controller.handlePress('input_server');
    harness.controller.handleRelease('input_server');

    expect(harness.getLastEvent().reason).toBe('toggle-on');
    expect(harness.controller.getSnapshot().toggleLatched).toBe(true);
    expect(harness.controller.getSnapshot().isActive).toBe(true);

    harness.controller.handlePress('input_server');
    harness.controller.handleRelease('input_server');

    expect(harness.getLastEvent().reason).toBe('toggle-off');
    expect(harness.controller.getSnapshot().toggleLatched).toBe(false);
    expect(harness.controller.getSnapshot().isActive).toBe(false);
  });

  it('hold mode shows on press and hides on release', () => {
    const harness = createHarness();

    harness.controller.handlePress('input_server');

    expect(harness.getLastEvent().reason).toBe('hold-activated');
    expect(harness.controller.getSnapshot().holdActive).toBe(true);
    expect(harness.controller.getSnapshot().isActive).toBe(true);

    harness.controller.handleRelease('input_server');

    expect(harness.getLastEvent().reason).toBe('hold-released');
    expect(harness.controller.getSnapshot().holdActive).toBe(false);
    expect(harness.controller.getSnapshot().isActive).toBe(false);
  });

  it('electron hold mode stays active until the watchdog expires', () => {
    const harness = createHarness();

    harness.controller.handleElectronSignal('electron');
    harness.controller.handleElectronSignal('electron');

    const holdActivations = harness.events.filter((event) => event.reason === 'hold-activated');
    expect(holdActivations).toHaveLength(1);
    expect(harness.controller.getSnapshot().isActive).toBe(true);

    vi.advanceTimersByTime(651);

    expect(harness.getLastEvent().reason).toBe('hold-released');
    expect(harness.controller.getSnapshot().isActive).toBe(false);
  });

  it('electron toggle mode toggles immediately on each shortcut callback', () => {
    const harness = createHarness();
    harness.setMode(MANUAL_HOTKEY_MODE_TOGGLE);

    harness.controller.handleElectronSignal('electron');

    const toggleEvents = harness.events.filter((event) => event.reason.startsWith('toggle-'));
    expect(toggleEvents).toHaveLength(1);
    expect(harness.getLastEvent().reason).toBe('toggle-on');
    expect(harness.controller.getSnapshot().toggleLatched).toBe(true);

    harness.controller.handleElectronSignal('electron');

    expect(harness.getLastEvent().reason).toBe('toggle-off');
    expect(harness.controller.getSnapshot().toggleLatched).toBe(false);
    expect(harness.events.filter((event) => event.reason.startsWith('toggle-'))).toHaveLength(2);
  });

  it('resolves modifier-only bindings to input server and normal hotkeys to electron', () => {
    expect(resolveManualHotkeyBackend('Shift')).toBe(MANUAL_HOTKEY_BACKEND_INPUT_SERVER);
    expect(resolveManualHotkeyBackend('Shift+Space')).toBe(MANUAL_HOTKEY_BACKEND_ELECTRON);
  });
});
