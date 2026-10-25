// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildCaptureMap } from "./OCRCaptureMap";

describe("buildCaptureMap", () => {
  it("preserves saved percentage positions and classifies special areas before ordinary capture areas", () => {
    const result = buildCaptureMap({
      coordinate_system: "percentage",
      rectangles: [
        { coordinates: [0.1, 0.7, 0.8, 0.2] },
        { coordinates: [0.05, 0.1, 0.3, 0.4], is_secondary: true },
        { coordinates: [0.1, 0.1, 0.1, 0.1], is_excluded: true, is_secondary: true },
        { coordinates: [0, 0, 0.1, 0.1], is_black_hole: true },
        { coordinates: [0.4, 0.1, 0.1, 0.1], is_exclusive: true }
      ]
    });
    expect(result.available).toBe(true);
    expect(result.areas.map((area) => area.kind)).toEqual([
      "normal",
      "secondary",
      "excluded",
      "black-hole",
      "exclusive"
    ]);
    expect(result.areas[0]).toMatchObject({ x: 10, y: 70, width: 80 });
    expect(result.areas[0].height).toBeCloseTo(20);
  });

  it("clips areas to the source and rejects malformed or unknown coordinate systems", () => {
    const clipped = buildCaptureMap({
      coordinate_system: "percentage",
      rectangles: [{ coordinates: [-0.1, 0.9, 0.3, 0.3] }]
    });
    expect(clipped.available).toBe(true);
    expect(clipped.areas[0].x).toBe(0);
    expect(clipped.areas[0].width).toBeCloseTo(20);
    expect(clipped.areas[0].height).toBeCloseTo(10);
    for (const rectangles of [
      [{}],
      [null],
      [{ coordinates: [0, 0, NaN, 1] }],
      [{ coordinates: [0, 0, -1, 1] }]
    ]) {
      expect(buildCaptureMap({ coordinate_system: "percentage", rectangles }).available).toBe(
        false
      );
    }
    expect(
      buildCaptureMap({
        coordinate_system: "screen",
        rectangles: [{ coordinates: [100, 100, 400, 200] }]
      }).available
    ).toBe(false);
    expect(buildCaptureMap(null).available).toBe(false);
  });
});
