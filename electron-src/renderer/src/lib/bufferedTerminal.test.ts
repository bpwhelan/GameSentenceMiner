import { describe, expect, it, vi } from "vitest";
import { createBufferedTerminalWriter } from "./bufferedTerminal";

describe("buffered terminal output", () => {
  it("batches visible bursts without parsing hidden output or writing after disposal", () => {
    vi.useFakeTimers();
    try {
      let visible = true;
      const write = vi.fn();
      const output = createBufferedTerminalWriter(write, () => visible, { batchIntervalMs: 16 });
      output.write("first\r\n");
      output.write("second\r\n");
      expect(write).not.toHaveBeenCalled();
      vi.advanceTimersByTime(16);
      expect(write).toHaveBeenCalledExactlyOnceWith("first\r\nsecond\r\n");
      write.mockClear();
      output.write("before hiding\r\n");
      visible = false;
      vi.advanceTimersByTime(16);
      output.write("hidden\r\n");
      expect(write).not.toHaveBeenCalled();
      visible = true;
      output.flush();
      expect(write).toHaveBeenCalledExactlyOnceWith("before hiding\r\nhidden\r\n");
      write.mockClear();
      output.write("discarded at shutdown\r\n");
      output.dispose();
      output.write("after disposal\r\n");
      vi.runAllTimers();
      expect(write).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
  it.each(["separate writes", "one write"])("keeps at most fifty pending lines from %s", (mode) => {
    let visible = false;
    const write = vi.fn();
    const output = createBufferedTerminalWriter(write, () => visible);
    const lines = Array.from({ length: 200 }, (_, i) => `Line ${i}\r\n`);
    if (mode === "one write") output.write(lines.join(""));
    else for (const line of lines) output.write(line);
    visible = true;
    output.flush();
    const data = write.mock.calls[0][0];
    expect(data.match(/\n/g)).toHaveLength(50);
    expect(data).toContain("Line 150\r\n");
    expect(data).toContain("Line 199\r\n");
    expect(data).not.toContain("Line 149\r\n");
  });
  it("parses no hidden output and flushes it in order when visible", () => {
    let visible = false;
    const write = vi.fn();
    const output = createBufferedTerminalWriter(write, () => visible);
    output.write("first\r\n");
    output.write("second\r\n");
    output.flush();
    expect(write).not.toHaveBeenCalled();
    visible = true;
    output.write("third\r\n");
    expect(write.mock.calls).toEqual([["first\r\nsecond\r\n"], ["third\r\n"]]);
    output.flush();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("clears pending output and handles writes starting with a newline", () => {
    let visible = false;
    const write = vi.fn();
    const output = createBufferedTerminalWriter(write, () => visible);
    output.write("discarded\n");
    output.clear();
    output.write("\nremaining\n");
    visible = true;
    output.flush();
    expect(write).toHaveBeenCalledExactlyOnceWith("\nremaining\n");
  });

  it("bounds hidden output and preserves complete recent ANSI writes", () => {
    let visible = false;
    const write = vi.fn();
    const output = createBufferedTerminalWriter(write, () => visible, { maxCharacters: 32 });
    for (let i = 0; i < 10_000; i++) output.write(`\x1b[36m${i}\x1b[0m\r\n`);
    visible = true;
    output.flush();
    expect(write).toHaveBeenCalledOnce();
    const [data] = write.mock.calls[0];
    expect(data.length).toBeLessThanOrEqual(36);
    expect(data).toContain("\x1b[36m9999\x1b[0m\r\n");
    expect(data).not.toContain("9997");
  });

  it("bounds a single oversized write and keeps later output", () => {
    let visible = false;
    const write = vi.fn();
    const output = createBufferedTerminalWriter(write, () => visible, { maxCharacters: 32 });
    output.write(`${"old line\n".repeat(1000)}latest\r\n`);
    output.write("end\r\n");
    visible = true;
    output.flush();
    expect(write.mock.calls[0][0].length).toBeLessThanOrEqual(36);
    expect(write.mock.calls[0][0]).toContain("latest\r\nend\r\n");
  });
});
