import { DEBUG_LOG_HISTORY_LIMIT, DEBUG_TERMINAL_BUFFER_CHARACTERS } from "./debugHistory";

interface BufferedTerminalOptions {
  maxCharacters?: number;
  maxLines?: number;
  batchIntervalMs?: number;
}

/** Defer xterm parsing while hidden, retaining a bounded tail of recent output. */
export function createBufferedTerminalWriter(
  write: (data: string) => void,
  visible: () => boolean,
  options: BufferedTerminalOptions = {},
) {
  const limit = options.maxCharacters ?? DEBUG_TERMINAL_BUFFER_CHARACTERS;
  const maxLines = options.maxLines ?? DEBUG_LOG_HISTORY_LIMIT;
  const batchIntervalMs = options.batchIntervalMs ?? 0;
  let chunks: Array<{ data: string; lines: number }> = [];
  let length = 0;
  let lines = 0;
  let truncated = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const cancelFlush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const clear = () => {
    cancelFlush();
    chunks = [];
    length = 0;
    lines = 0;
    truncated = false;
  };

  const flush = () => {
    cancelFlush();
    if (disposed || !visible() || !chunks.length) return;
    const data = `${truncated ? "\x1b[0m" : ""}${chunks.map(chunk => chunk.data).join("")}`;
    clear();
    write(data);
  };

  return {
    flush,
    clear,
    dispose() {
      disposed = true;
      clear();
    },
    write(data: string) {
      if (disposed || !data) return;
      if (visible() && batchIntervalMs === 0) {
        flush();
        write(data);
        return;
      }
      // Drop whole writes so ANSI sequences from ordinary log lines stay intact.
      if (data.length > limit) {
        data = data.slice(-limit);
        const newline = data.indexOf("\n");
        if (newline >= 0) data = data.slice(newline + 1);
        truncated = true;
      }
      let chunkLines = 0;
      let end = data.length;
      while (end > 0 && (end = data.lastIndexOf("\n", end - 1)) >= 0) {
        if (++chunkLines > maxLines) {
          data = data.slice(end + 1);
          chunkLines = maxLines;
          truncated = true;
          break;
        }
      }
      chunks.push({ data, lines: chunkLines });
      length += data.length;
      lines += chunkLines;
      while (length > limit || lines > maxLines) {
        const removed = chunks.shift()!;
        length -= removed.data.length;
        lines -= removed.lines;
        truncated = true;
      }
      if (visible() && timer === null) timer = setTimeout(flush, batchIntervalMs);
    },
  };
}
