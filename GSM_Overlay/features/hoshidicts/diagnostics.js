const fs = require("fs");
const path = require("path");

const HOSHIDICTS_LOG_PREFIX = "[HoshidictsReader]";
const DEFAULT_MAX_LOG_BYTES = 1024 * 1024;
const MAX_MESSAGE_LENGTH = 16 * 1024;

function normalizeConsoleMessageArguments(args) {
  if (
    args.length === 1 &&
    args[0] &&
    typeof args[0] === "object" &&
    typeof args[0].message === "string"
  ) {
    return {
      level: String(args[0].level || "info"),
      message: args[0].message,
      line: Number.isFinite(args[0].lineNumber) ? args[0].lineNumber : null,
      sourceId: typeof args[0].sourceId === "string" ? args[0].sourceId : "",
    };
  }

  return {
    level: String(args[0] || "info"),
    message: typeof args[1] === "string" ? args[1] : "",
    line: Number.isFinite(args[2]) ? args[2] : null,
    sourceId: typeof args[3] === "string" ? args[3] : "",
  };
}

function formatHoshidictsDiagnosticLine(entry, now = new Date()) {
  if (!entry || typeof entry.message !== "string") {
    return null;
  }
  const message = entry.message.trim();
  if (!message.startsWith(HOSHIDICTS_LOG_PREFIX)) {
    return null;
  }

  const timestamp = now instanceof Date && Number.isFinite(now.getTime())
    ? now.toISOString()
    : new Date().toISOString();
  const level = String(entry.level || "info").toUpperCase().slice(0, 16);
  const safeMessage = message
    .replace(/\r/gu, "\\r")
    .replace(/\n/gu, "\\n")
    .slice(0, MAX_MESSAGE_LENGTH);
  const sourceName = entry.sourceId ? path.basename(String(entry.sourceId)).slice(0, 256) : "";
  const lineNumber = Number.isFinite(entry.line) ? Math.max(0, Math.trunc(entry.line)) : null;
  const sourceSuffix = sourceName
    ? ` (${sourceName}${lineNumber === null ? "" : `:${lineNumber}`})`
    : "";
  return `${timestamp} ${level} ${safeMessage}${sourceSuffix}\n`;
}

function appendHoshidictsDiagnostic(logPath, entry, options = {}) {
  const line = formatHoshidictsDiagnosticLine(entry, options.now);
  if (!line) {
    return false;
  }

  const maxBytes = Number.isFinite(options.maxBytes) && options.maxBytes > 0
    ? Math.trunc(options.maxBytes)
    : DEFAULT_MAX_LOG_BYTES;
  const directory = path.dirname(logPath);
  fs.mkdirSync(directory, { recursive: true });

  try {
    if (fs.statSync(logPath).size >= maxBytes) {
      const rotatedPath = `${logPath}.1`;
      try {
        fs.rmSync(rotatedPath, { force: true });
      } catch {
        // Rotation is best-effort; append to the active log if cleanup fails.
      }
      fs.renameSync(logPath, rotatedPath);
    }
  } catch {
    // A missing active log is expected on first use.
  }

  fs.appendFileSync(logPath, line, "utf8");
  return true;
}

/**
 * Mirrors overlay renderer console output into the Hoshidicts diagnostic log.
 * `registerListener` lets the overlay keep ownership of listener cleanup.
 */
function attachHoshidictsRendererDiagnostics(options = {}) {
  const { logPath, registerListener, webContents } = options;
  if (!logPath || !webContents || typeof registerListener !== "function") {
    return false;
  }
  const warn = (message, error) => {
    console.warn(`[HoshidictsDiagnostics] ${message}`, error);
  };
  try {
    appendHoshidictsDiagnostic(logPath, {
      level: "info",
      message: `${HOSHIDICTS_LOG_PREFIX} diagnostics.ready ${JSON.stringify({
        logPath,
      })}`,
    });
  } catch (error) {
    warn("Could not initialize the log file:", error);
  }
  registerListener(webContents, "console-message", (_event, ...args) => {
    try {
      appendHoshidictsDiagnostic(logPath, normalizeConsoleMessageArguments(args));
    } catch (error) {
      warn("Could not append renderer diagnostics:", error);
    }
  });
  return true;
}

module.exports = {
  appendHoshidictsDiagnostic,
  attachHoshidictsRendererDiagnostics,
  normalizeConsoleMessageArguments,
};
