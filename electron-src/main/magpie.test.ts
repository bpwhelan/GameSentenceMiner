import { createRequire } from "module";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
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

const overlayHtml = readFileSync(new URL("../../GSM_Overlay/index.html", import.meta.url), "utf8");
const fallbackMapping = overlayHtml.slice(
  overlayHtml.indexOf("  function mapPercentToMagpie("),
  overlayHtml.indexOf("  // Track multiple Yomitan popups"),
);

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

  describe.each(["module", "renderer fallback"])("%s monitor mapping", (implementation) => {
    it.each([
      { x: 2560, y: 164, width: 1920, height: 1080 },
      { x: -1920, y: -1080, width: 1920, height: 1080 },
    ])("maps correctly on a display at ($x, $y), including mixed DPI", (physicalBounds) => {
      const { x, y, width, height } = physicalBounds;
      const info = {
        sourceWindowLeftEdgePosition: x + 320,
        sourceWindowTopEdgePosition: y + 180,
        sourceWindowRightEdgePosition: x + 1600,
        sourceWindowBottomEdgePosition: y + 900,
        magpieWindowLeftEdgePosition: x,
        magpieWindowTopEdgePosition: y,
        magpieWindowRightEdgePosition: x + width,
        magpieWindowBottomEdgePosition: y + height,
      };
      const display = {
        physicalBounds,
        physicalSize: { width, height },
        bounds: { x: x / 2, y: y / 2, width: width / 2, height: height / 2 },
        scaleFactor: 2,
      };
      const map = implementation === "module"
        ? (px: number, py: number) => mapPercentToMagpie(px, py, createMagpieState(info), display)
        : runInNewContext(`${fallbackMapping}; mapPercentToMagpie`, {
          magpieController: null, isMagpieActive: true, currentMagpieInfo: info, display,
        });
      const topLeft = map(320 / width * 100, 180 / height * 100);
      const bottomRight = map(1600 / width * 100, 900 / height * 100);
      expect(topLeft.x).toBeCloseTo(0, 6);
      expect(topLeft.y).toBeCloseTo(0, 6);
      expect(bottomRight.x).toBeCloseTo(100, 6);
      expect(bottomRight.y).toBeCloseTo(100, 6);
    });
  });

  it("keeps the mouse-release cadence when unchanged geometry arrives repeatedly", () => {
    const requestMouseRelease = vi.fn();
    const controller = createMagpieRendererController({ requestMouseRelease, logger: { log() {} } });
    controller.applyInfo(ACTIVE_MAGPIE_INFO);
    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(200);
      controller.applyInfo({ ...ACTIVE_MAGPIE_INFO });
    }
    expect(requestMouseRelease).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(200);
    expect(requestMouseRelease).toHaveBeenCalledTimes(2);
    controller.dispose();
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
