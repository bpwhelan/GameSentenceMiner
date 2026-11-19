import { describe, expect, it } from "vitest";
import {
  formatOriginAnsi,
  normalizeOriginSource,
  originCategory,
  parseLogLevelFromLine,
  splitLogOrigin,
  stripAnsi,
} from "./logFormat";

describe("logFormat", () => {
  it("strips ANSI escape sequences", () => {
    expect(stripAnsi("\x1b[93m[py:backend]\x1b[0m hello")).toBe("[py:backend] hello");
  });

  it("splits canonical runtime origin prefixes with or without ANSI wrappers", () => {
    expect(splitLogOrigin("[py:backend] 2026-11-19 12:30:01 | MAIN | INFO | Ready")).toEqual({
      origin: "py:backend",
      rest: "2026-11-19 12:30:01 | MAIN | INFO | Ready",
    });
    expect(splitLogOrigin("\x1b[38;5;208m[rust:obs]\x1b[0m Scene switched")).toEqual({
      origin: "rust:obs",
      rest: "Scene switched",
    });
    expect(splitLogOrigin("[frida:agent] Attach: present hook")).toEqual({
      origin: "frida:agent",
      rest: "Attach: present hook",
    });
    expect(splitLogOrigin("[renderer:gsm-hub] Console warning")).toEqual({
      origin: "renderer:gsm-hub",
      rest: "Console warning",
    });
  });

  it("does not misclassify non-origin bracket prefixes", () => {
    expect(splitLogOrigin("[final] こんにちは")).toEqual({
      origin: null,
      rest: "[final] こんにちは",
    });
    expect(splitLogOrigin("[Agent] Hook attached")).toEqual({
      origin: null,
      rest: "[Agent] Hook attached",
    });
    expect(splitLogOrigin("[Update Guard] Waiting")).toEqual({
      origin: null,
      rest: "[Update Guard] Waiting",
    });
  });

  it("normalizes short source identifiers", () => {
    expect(normalizeOriginSource("python")).toBe("py:backend");
    expect(normalizeOriginSource("electron")).toBe("electron:main");
    expect(normalizeOriginSource("setup")).toBe("rust:python-install");
    expect(normalizeOriginSource("rust:overlay")).toBe("rust:overlay");
    expect(normalizeOriginSource("py:ocr")).toBe("py:ocr");
    expect(normalizeOriginSource("")).toBeNull();
    expect(normalizeOriginSource(undefined)).toBeNull();
  });

  it("parses log levels from legacy and origin-prefixed Python and Rust lines", () => {
    expect(
      parseLogLevelFromLine("2026-11-19 12:30:01 | MAIN       | BACKGROUND | Booting")
    ).toBe("BACKGROUND");
    expect(
      parseLogLevelFromLine("[py:backend] 2026-11-19 12:30:01 | ANKI       | INFO       | Card updated")
    ).toBe("INFO");
    expect(
      parseLogLevelFromLine("[py:backend] 2026-11-19 12:30:01 | GAMETEXT   | TEXT_RECEIVED | こんにちは")
    ).toBe("TEXT_RECEIVED");
    expect(
      parseLogLevelFromLine("[rust:obs] 2026-11-19 12:30:01 | WARNING    | Reconnecting")
    ).toBe("WARNING");
    expect(
      parseLogLevelFromLine("[rust:startup] 2026-11-19 12:30:01.123 | WARN | Retrying")
    ).toBe("WARNING");
    expect(
      parseLogLevelFromLine("[rust:overlay] 2026-11-19 12:30:01 | BACKGROUND | Idle frame")
    ).toBe("BACKGROUND");
    expect(parseLogLevelFromLine("Plain stdout text")).toBeUndefined();
  });

  it("categorizes and ANSI-formats origins cleanly", () => {
    expect(originCategory("py:backend")).toBe("python");
    expect(originCategory("rust:obs")).toBe("rust");
    expect(originCategory("renderer:gsm-hub")).toBe("renderer");
    expect(originCategory("electron:main")).toBe("electron");
    expect(originCategory("frida:agent")).toBe("frida");
    expect(formatOriginAnsi("py:backend")).toBe("\x1b[93m[py:backend]\x1b[0m");
    expect(formatOriginAnsi("rust:obs")).toBe("\x1b[38;5;208m[rust:obs]\x1b[0m");
    expect(formatOriginAnsi("py:backend", true)).toBe("\x1b[90m[py:backend]\x1b[0m");
  });
});
