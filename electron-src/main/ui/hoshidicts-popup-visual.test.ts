import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import sharp from "sharp";
import { afterAll, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const electronBinary = require("electron") as string;
const harness = path.resolve(
  process.cwd(),
  "electron-src/main/ui/fixtures/hoshidicts-popup-capture.cjs",
);
const outputDirectory = fs.mkdtempSync(
  path.join(os.tmpdir(), "gsm-hoshidicts-popup-"),
);

afterAll(() => {
  fs.rmSync(outputDirectory, { recursive: true, force: true });
});

describe("HoshiDicts Electron visual matrix", () => {
  it(
    "captures nonblank on-screen popup states across content, scale, edges, and themes",
    async () => {
      const command =
        process.platform === "linux" ? "/usr/bin/xvfb-run" : electronBinary;
      const args =
        process.platform === "linux"
          ? ["-a", electronBinary, "--no-sandbox", harness, outputDirectory]
          : [harness, outputDirectory];
      const result = spawnSync(command, args, {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          ELECTRON_DISABLE_SANDBOX: "1",
        },
        timeout: 60_000,
      });
      expect(result.status, result.stderr).toBe(0);
      const outputLine = result.stdout
        .trim()
        .split(/\r?\n/u)
        .findLast((line) => line.startsWith("["));
      expect(outputLine).toBeTruthy();
      const captures = JSON.parse(outputLine!) as Array<{
        name: string;
        paintMs: number;
        textLength: number;
        rect: { x: number; y: number; width: number; height: number };
        viewport: { width: number; height: number };
        imageCount: number;
        visibleImageCount: number;
        filePath: string;
        pngBytes: number;
      }>;

      expect(captures.map((capture) => capture.name)).toEqual([
        "short",
        "long",
        "multiple",
        "media",
        "empty",
        "error",
        "edge",
        "light",
        "dark",
        "high-dpi",
      ]);
      for (const capture of captures) {
        expect(capture.textLength).toBeGreaterThan(0);
        expect(capture.rect.width).toBeGreaterThan(100);
        expect(capture.rect.height).toBeGreaterThan(30);
        expect(capture.rect.x).toBeGreaterThanOrEqual(0);
        expect(capture.rect.y).toBeGreaterThanOrEqual(0);
        expect(capture.rect.x + capture.rect.width).toBeLessThanOrEqual(
          capture.viewport.width + 1,
        );
        expect(capture.rect.y + capture.rect.height).toBeLessThanOrEqual(
          capture.viewport.height + 1,
        );
        expect(capture.paintMs).toBeLessThan(200);
        expect(capture.pngBytes).toBeGreaterThan(1000);

        const stats = await sharp(capture.filePath).stats();
        const populatedChannels = stats.channels.filter(
          (channel) => channel.max > channel.min,
        );
        expect(populatedChannels.length).toBeGreaterThan(0);
      }
      expect(captures.find((capture) => capture.name === "media")?.imageCount).toBe(
        1,
      );
      expect(
        captures.find((capture) => capture.name === "media")?.visibleImageCount,
      ).toBe(1);
    },
    70_000,
  );
});
