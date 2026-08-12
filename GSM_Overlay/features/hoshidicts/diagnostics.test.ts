import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const diagnostics = require("./diagnostics.js");

const tempDirs: string[] = [];

function makeTempDir() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "gsm-hoshidicts-log-"));
  tempDirs.push(directory);
  return directory;
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("Hoshidicts renderer diagnostics", () => {
  it("normalizes both Electron console-message event shapes", () => {
    expect(
      diagnostics.normalizeConsoleMessageArguments([
        {
          level: "warning",
          message: "[HoshidictsReader] socket.closed",
          lineNumber: 42,
          sourceId: "file:///overlay/hoshidicts_reader.js"
        }
      ])
    ).toEqual({
      level: "warning",
      message: "[HoshidictsReader] socket.closed",
      line: 42,
      sourceId: "file:///overlay/hoshidicts_reader.js"
    });

    expect(
      diagnostics.normalizeConsoleMessageArguments([
        2,
        "[HoshidictsReader] lookup.failed",
        99,
        "file:///overlay/hoshidicts_reader.js"
      ])
    ).toEqual({
      level: "2",
      message: "[HoshidictsReader] lookup.failed",
      line: 99,
      sourceId: "file:///overlay/hoshidicts_reader.js"
    });
  });

  it("writes only Hoshidicts messages and rotates a bounded log", () => {
    const directory = makeTempDir();
    const logPath = path.join(directory, "logs", "hoshidicts-reader.log");
    const now = new Date("2026-08-05T19:30:00.000Z");

    expect(
      diagnostics.appendHoshidictsDiagnostic(
        logPath,
        { level: "info", message: "unrelated renderer output" },
        { now, maxBytes: 128 }
      )
    ).toBe(false);
    expect(fs.existsSync(logPath)).toBe(false);

    expect(
      diagnostics.appendHoshidictsDiagnostic(
        logPath,
        {
          level: "warning",
          message: "[HoshidictsReader] lookup.failed\nbackend unavailable",
          line: 12,
          sourceId: "file:///overlay/hoshidicts_reader.js"
        },
        { now, maxBytes: 128 }
      )
    ).toBe(true);
    const firstLog = fs.readFileSync(logPath, "utf8");
    expect(firstLog).toContain(
      "2026-08-05T19:30:00.000Z WARNING [HoshidictsReader] lookup.failed\\nbackend unavailable"
    );
    expect(firstLog).toContain("(hoshidicts_reader.js:12)");

    fs.appendFileSync(logPath, "x".repeat(128), "utf8");
    diagnostics.appendHoshidictsDiagnostic(
      logPath,
      { level: "info", message: "[HoshidictsReader] reader.destroyed" },
      { now, maxBytes: 128 }
    );

    expect(fs.existsSync(`${logPath}.1`)).toBe(true);
    expect(fs.readFileSync(logPath, "utf8")).toContain("reader.destroyed");
  });
  it("mirrors renderer console output into the diagnostic log", () => {
    const directory = makeTempDir();
    const logPath = path.join(directory, "logs", "hoshidicts-reader.log");
    const listeners: Array<[unknown, string, (...args: any[]) => void]> = [];
    const webContents = { id: 1 };

    expect(
      diagnostics.attachHoshidictsRendererDiagnostics({
        logPath,
        registerListener: (target: unknown, event: string, listener: any) => {
          listeners.push([target, event, listener]);
        },
        webContents
      })
    ).toBe(true);
    expect(fs.readFileSync(logPath, "utf8")).toContain("diagnostics.ready");
    expect(listeners).toHaveLength(1);
    expect(listeners[0][0]).toBe(webContents);
    expect(listeners[0][1]).toBe("console-message");

    listeners[0][2]({}, {
      level: "warning",
      message: "[HoshidictsReader] lookup.failed",
      lineNumber: 7,
      sourceId: "file:///overlay/reader.js"
    });
    expect(fs.readFileSync(logPath, "utf8")).toContain("lookup.failed");

    // A disabled feature (no log path) must not register any listener.
    expect(
      diagnostics.attachHoshidictsRendererDiagnostics({
        logPath: "",
        registerListener: () => {
          throw new Error("must not register");
        },
        webContents
      })
    ).toBe(false);
  });
});
