export type OriginCategory = "python" | "rust" | "renderer" | "electron" | "frida" | "other";

const ANSI_ESCAPE_GLOBAL = /\u001b\[[0-9;]*m/g;
const ORIGIN_PREFIX_PATTERN =
  /^((?:\u001b\[[0-9;]*m)*)\[((?:py|python|rust|electron|renderer|frida|system)(?::[a-zA-Z0-9._/-]+)?)\](?:\u001b\[[0-9;]*m)*(\s+|$)/i;

const KNOWN_LEVELS = new Set([
  "TRACE",
  "DEBUG",
  "BACKGROUND",
  "INFO",
  "TEXT_RECEIVED",
  "DISPLAY",
  "SUCCESS",
  "WARNING",
  "WARN",
  "ERROR",
  "CRITICAL",
]);

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE_GLOBAL, "");
}

export function splitLogOrigin(line: string): { origin: string | null; rest: string } {
  const match = line.match(ORIGIN_PREFIX_PATTERN);
  if (!match) {
    return { origin: null, rest: line };
  }
  return {
    origin: match[2],
    rest: line.slice(match[0].length),
  };
}

export function normalizeOriginSource(source?: string | null): string | null {
  const trimmed = (source ?? "").trim();
  if (!trimmed) {
    return null;
  }
  const lower = trimmed.toLowerCase();
  if (lower === "python") return "py:backend";
  if (lower === "electron") return "electron:main";
  if (lower === "setup") return "rust:python-install";
  if (lower === "system") return "system";
  return trimmed;
}

function normalizeLevel(raw: string): string | undefined {
  const upper = raw.toUpperCase();
  if (!KNOWN_LEVELS.has(upper)) {
    return undefined;
  }
  return upper === "WARN" ? "WARNING" : upper;
}

export function parseLogLevelFromLine(line: string): string | undefined {
  const clean = stripAnsi(line).trimStart();
  const { rest } = splitLogOrigin(clean);
  const body = rest.trimStart();

  // 3-field Python loguru format: YYYY-MM-DD HH:MM:SS(.SSS)? | COMPONENT | LEVEL | message
  const threeField = body.match(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?\s+\|\s+[^|]+\|\s+([A-Z_]+)\s+\|/i
  );
  if (threeField) {
    const level = normalizeLevel(threeField[1]);
    if (level) return level;
  }

  // 2-field Rust/desktop format: YYYY-MM-DD HH:MM:SS(.SSS)? | LEVEL | message
  const twoField = body.match(
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d{3})?\s+\|\s+([A-Z_]+)\s+\|/i
  );
  if (twoField) {
    const level = normalizeLevel(twoField[1]);
    if (level) return level;
  }

  return undefined;
}

export function originCategory(origin: string): OriginCategory {
  const lower = origin.toLowerCase();
  if (lower === "py" || lower === "python" || lower.startsWith("py:") || lower.startsWith("python:")) {
    return "python";
  }
  if (lower === "rust" || lower.startsWith("rust:")) {
    return "rust";
  }
  if (lower === "renderer" || lower.startsWith("renderer:")) {
    return "renderer";
  }
  if (lower === "electron" || lower.startsWith("electron:")) {
    return "electron";
  }
  if (lower === "frida" || lower.startsWith("frida:")) {
    return "frida";
  }
  return "other";
}

export function formatOriginAnsi(origin: string, dimmed = false): string {
  if (dimmed) {
    return `\x1b[90m[${origin}]\x1b[0m`;
  }
  switch (originCategory(origin)) {
    case "python":
      return `\x1b[93m[${origin}]\x1b[0m`;
    case "rust":
      return `\x1b[38;5;208m[${origin}]\x1b[0m`;
    case "renderer":
    case "electron":
      return `\x1b[95m[${origin}]\x1b[0m`;
    case "frida":
      return `\x1b[94m[${origin}]\x1b[0m`;
    default:
      return `\x1b[96m[${origin}]\x1b[0m`;
  }
}
