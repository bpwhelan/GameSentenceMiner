import { createRequire } from "module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const require = createRequire(import.meta.url);
const {
  createMagpieRendererController,
  createMagpieState,
  mapPercentToMagpie,
  normalizeMagpieInfo,
} = require("../../GSM_Overlay/magpie.js");

const ACTIVE_MAGPIE_INFO = {
  magpieWindowTopEdgePosition: 0,
  magpieWindowBottomEdgePosition: 1440,
  magpieWindowLeftEdgePosition: 0,
  magpieWindowRightEdgePosition: 2560,
  sourceWindowLeftEdgePosition: 620,
  sourceWindowTopEdgePosition: 342,
  sourceWindowRightEdgePosition: 1900,
  sourceWindowBottomEdgePosition: 1062,
};

describe("magpie", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("treats invalid zero-sized Magpie geometry as inactive", () => {
    const normalized = normalizeMagpieInfo({
      ...ACTIVE_MAGPIE_INFO,
      magpieWindowRightEdgePosition: 0,
      sourceWindowRightEdgePosition: 620,
    });

    expect(normalized).toBeNull();
    expect(createMagpieState({
      ...ACTIVE_MAGPIE_INFO,
      magpieWindowRightEdgePosition: 0,
      sourceWindowRightEdgePosition: 620,
    })).toMatchObject({
      active: false,
      info: null,
      signature: null,
    });
  });

  it("maps source-window monitor percentages into Magpie destination space", () => {
    const state = createMagpieState(ACTIVE_MAGPIE_INFO);

    const topLeft = mapPercentToMagpie(
      ((620 + 0) / 2560) * 100,
      ((342 + 0) / 1440) * 100,
      state,
      { physicalSize: { width: 2560, height: 1440 } },
    );
    const bottomRight = mapPercentToMagpie(
      ((1900) / 2560) * 100,
      ((1062) / 1440) * 100,
      state,
      { physicalSize: { width: 2560, height: 1440 } },
    );

    expect(topLeft.x).toBeCloseTo(0, 6);
    expect(topLeft.y).toBeCloseTo(0, 6);
    expect(bottomRight.x).toBeCloseTo(100, 6);
    expect(bottomRight.y).toBeCloseTo(100, 6);
  });

  it("starts and stops Magpie compatibility releases from normalized state", () => {
    const releaseReasons: string[] = [];
    const passThroughReasons: string[] = [];
    const controller = createMagpieRendererController({
      requestMouseRelease(reason: string) {
        releaseReasons.push(reason);
      },
      restoreMouseIgnore(reason: string) {
        passThroughReasons.push(reason);
      },
      isYomitanShowing() {
        return false;
      },
      isManualHotkeyPressed() {
        return false;
      },
      setIntervalFn: setInterval,
      clearIntervalFn: clearInterval,
      logger: { log() {}, warn() {}, error() {} },
    });

    controller.applyInfo(ACTIVE_MAGPIE_INFO, "window-state");

    expect(controller.getState().active).toBe(true);
    expect(releaseReasons).toHaveLength(1);

    vi.advanceTimersByTime(1000);
    expect(releaseReasons).toHaveLength(2);

    controller.applyInfo(null, "window-state");
    expect(controller.getState().active).toBe(false);

    vi.advanceTimersByTime(2000);
    expect(releaseReasons).toHaveLength(2);

    controller.restorePassThrough("manual-mode");
    expect(passThroughReasons).toEqual(["manual-mode"]);
  });
});
