"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const hoshidictsProvenance = require("./hoshidicts_host/provenance.json");

const PROTOCOL_VERSION = Object.freeze({ major: 1, minor: 0 });
const EXPECTED_HOSHIDICTS_COMMIT = hoshidictsProvenance.source.commit;
const MAX_REQUEST_LINE_BYTES = 1024 * 1024;
const MAX_RESPONSE_LINE_BYTES = 8 * 1024 * 1024;
const MAX_MEDIA_RESPONSE_LINE_BYTES = 16 * 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_IGNORED_RESPONSE_IDS = 4096;

class HoshiDictsClientError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = "HoshiDictsClientError";
    this.code = code;
  }
}

class HoshiDictsHostError extends HoshiDictsClientError {
  constructor(code, message) {
    super(code || "HOST_ERROR", message || "HoshiDicts host request failed");
    this.name = "HoshiDictsHostError";
  }
}

class HoshiDictsProtocolError extends HoshiDictsClientError {
  constructor(message) {
    super("PROTOCOL_ERROR", message);
    this.name = "HoshiDictsProtocolError";
  }
}

class HoshiDictsTimeoutError extends HoshiDictsClientError {
  constructor(method) {
    super("TIMEOUT", `HoshiDicts host timed out while handling ${method}`);
    this.name = "HoshiDictsTimeoutError";
    this.method = method;
  }
}

class HoshiDictsCancelledError extends HoshiDictsClientError {
  constructor(requestId) {
    super("CANCELLED", `HoshiDicts request ${requestId} was cancelled`);
    this.name = "HoshiDictsCancelledError";
    this.requestId = requestId;
  }
}

class HoshiDictsHostExitedError extends HoshiDictsClientError {
  constructor(code, signal) {
    const detail = signal ? `signal ${signal}` : `code ${String(code)}`;
    super("HOST_EXITED", `HoshiDicts host exited with ${detail}`);
    this.name = "HoshiDictsHostExitedError";
    this.exitCode = code;
    this.signal = signal;
  }
}

function hostExecutableName(platform = process.platform) {
  return platform === "win32"
    ? "gsm_hoshidicts_host.exe"
    : "gsm_hoshidicts_host";
}

function isExecutableFile(candidate, platform, statSync = fs.statSync) {
  try {
    const stat = statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    if (platform === "win32") {
      return true;
    }
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function resolveHoshiDictsExecutable(options = {}) {
  const platform = options.platform || process.platform;
  const arch = options.arch || process.arch;
  const moduleDir = options.moduleDir || __dirname;
  const resourcesPath = options.resourcesPath || process.resourcesPath;
  const environment = options.env || process.env;
  const statSync = options.statSync || fs.statSync;
  const executableName = hostExecutableName(platform);

  const explicitPath = environment.GSM_HOSHIDICTS_HOST_PATH;
  if (explicitPath) {
    const resolved = path.resolve(explicitPath);
    if (!isExecutableFile(resolved, platform, statSync)) {
      throw new HoshiDictsClientError(
        "HOST_NOT_FOUND",
        "GSM_HOSHIDICTS_HOST_PATH does not point to an executable file",
      );
    }
    return resolved;
  }

  const candidates = [
    resourcesPath && path.join(resourcesPath, executableName),
    resourcesPath && path.join(resourcesPath, "hoshidicts", executableName),
    path.join(moduleDir, "hoshidicts_host", "bin", `${platform}-${arch}`, executableName),
    path.join(moduleDir, "hoshidicts_host", "bin", platform, executableName),
    path.join(moduleDir, "hoshidicts_host", "bin", executableName),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (isExecutableFile(candidate, platform, statSync)) {
      return candidate;
    }
  }

  throw new HoshiDictsClientError(
    "HOST_NOT_FOUND",
    `HoshiDicts host executable was not found for ${platform}-${arch}`,
  );
}

function normalizeTimeout(value, fallback) {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function resolvesWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    promise.then(() => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

class HoshiDictsClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.spawn = options.spawn || childProcess.spawn;
    this.executablePath = options.executablePath || null;
    this.clientVersion = options.clientVersion || "unknown";
    this.expectedHoshiDictsCommit =
      options.expectedHoshiDictsCommit || EXPECTED_HOSHIDICTS_COMMIT;
    this.handshakeTimeoutMs = normalizeTimeout(options.handshakeTimeoutMs, 5000);
    this.defaultTimeoutMs = normalizeTimeout(options.defaultTimeoutMs, 5000);
    this.shutdownTimeoutMs = normalizeTimeout(options.shutdownTimeoutMs, 2000);
    this.forceKillTimeoutMs = normalizeTimeout(options.forceKillTimeoutMs, 1000);
    this.maxRequestLineBytes = options.maxRequestLineBytes || MAX_REQUEST_LINE_BYTES;
    this.maxResponseLineBytes = options.maxResponseLineBytes || MAX_RESPONSE_LINE_BYTES;
    this.maxMediaResponseLineBytes =
      options.maxMediaResponseLineBytes || MAX_MEDIA_RESPONSE_LINE_BYTES;
    this.maxStderrBytes = options.maxStderrBytes || MAX_STDERR_BYTES;
    this.methodTimeouts = {
      "catalog.configure": 30_000,
      "dictionary.import": 30 * 60_000,
      "dictionary.probe": 30_000,
      "lookup.term": 3000,
      "lookup.kanji": 3000,
      "styles.list": 5000,
      "media.get": 5000,
      ...options.methodTimeouts,
    };

    this.child = null;
    this.ready = false;
    this.startPromise = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.ignoredResponseIds = new Map();
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrBuffer = "";
    this.protocolFailure = null;
  }

  async start() {
    if (this.ready) {
      return this.helloResult;
    }
    if (this.startPromise) {
      return this.startPromise;
    }

    this.startPromise = this.#start();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async #start() {
    const executablePath =
      this.executablePath ||
      resolveHoshiDictsExecutable({
        ...this.options.resolveOptions,
      });

    let child;
    try {
      child = this.spawn(executablePath, [], {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
        shell: false,
      });
    } catch (error) {
      throw new HoshiDictsClientError(
        "SPAWN_FAILED",
        "Unable to start the HoshiDicts host",
        { cause: error },
      );
    }

    if (!child || !child.stdin || !child.stdout || !child.stderr) {
      throw new HoshiDictsClientError(
        "SPAWN_FAILED",
        "HoshiDicts host did not expose the required standard streams",
      );
    }

    this.child = child;
    this.ready = false;
    this.protocolFailure = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrBuffer = "";

    child.stdout.on("data", (chunk) => this.#handleStdout(child, chunk));
    child.stderr.on("data", (chunk) => this.#handleStderr(child, chunk));
    child.stdin.on("error", (error) => this.#handleStreamError(child, error));
    child.on("error", (error) => this.#handleChildError(child, error));
    child.on("exit", (code, signal) => this.#handleExit(child, code, signal));

    try {
      const hello = await this.#request(
        "hello",
        {
          protocol: PROTOCOL_VERSION,
          client: "gsm-overlay",
          clientVersion: this.clientVersion,
        },
        {
          timeoutMs: this.handshakeTimeoutMs,
          allowBeforeReady: true,
        },
      );
      this.#validateHello(hello);
      this.helloResult = hello;
      this.ready = true;
      this.emit("ready", hello);
      return hello;
    } catch (error) {
      this.#killChild(child);
      throw error;
    }
  }

  request(method, params = {}, options = {}) {
    if (!this.ready) {
      return Promise.reject(
        new HoshiDictsClientError("NOT_READY", "HoshiDicts host is not ready"),
      );
    }
    return this.#request(method, params, options);
  }

  #request(method, params, options = {}) {
    if (!this.child || (!this.ready && !options.allowBeforeReady)) {
      return Promise.reject(
        new HoshiDictsClientError("NOT_RUNNING", "HoshiDicts host is not running"),
      );
    }
    if (typeof method !== "string" || !method || method.length > 128) {
      return Promise.reject(
        new HoshiDictsClientError("INVALID_METHOD", "HoshiDicts method is invalid"),
      );
    }

    const requestId = String(this.nextRequestId++);
    const timeoutMs = normalizeTimeout(
      options.timeoutMs,
      this.methodTimeouts[method] || this.defaultTimeoutMs,
    );
    let abortHandler = null;

    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(requestId);
        if (!pending) {
          return;
        }
        this.pending.delete(requestId);
        this.#rememberIgnoredResponse(requestId, method);
        this.#detachAbortHandler(pending);
        reject(new HoshiDictsTimeoutError(method));
        this.#sendCancel(requestId);
      }, timeoutMs);

      abortHandler = () => {
        this.cancel(requestId);
      };

      this.pending.set(requestId, {
        method,
        resolve,
        reject,
        timer,
        signal: options.signal || null,
        abortHandler,
      });

      if (options.signal) {
        if (options.signal.aborted) {
          this.cancel(requestId);
          return;
        }
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      try {
        this.#writeEnvelope({ id: requestId, method, params });
      } catch (error) {
        const pending = this.pending.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          this.#detachAbortHandler(pending);
          this.pending.delete(requestId);
        }
        reject(error);
      }
    });

    Object.defineProperty(promise, "requestId", {
      configurable: false,
      enumerable: true,
      value: requestId,
      writable: false,
    });
    return promise;
  }

  cancel(requestId) {
    const normalizedId = String(requestId);
    const pending = this.pending.get(normalizedId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timer);
    this.#detachAbortHandler(pending);
    this.pending.delete(normalizedId);
    this.#rememberIgnoredResponse(normalizedId, pending.method);
    pending.reject(new HoshiDictsCancelledError(normalizedId));
    this.#sendCancel(normalizedId);
    return true;
  }

  #sendCancel(targetRequestId) {
    if (!this.child || !this.ready) {
      return;
    }
    const cancelId = String(this.nextRequestId++);
    this.#rememberIgnoredResponse(cancelId, "cancel");
    try {
      this.#writeEnvelope({
        id: cancelId,
        method: "cancel",
        params: { requestId: targetRequestId },
      });
    } catch {
      // The original request already has a definitive timeout/cancel result.
    }
  }

  #writeEnvelope(envelope) {
    if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
      throw new HoshiDictsClientError("NOT_RUNNING", "HoshiDicts host stdin is closed");
    }

    let line;
    try {
      line = `${JSON.stringify(envelope)}\n`;
    } catch (error) {
      throw new HoshiDictsClientError(
        "INVALID_REQUEST",
        "HoshiDicts request is not JSON serializable",
        { cause: error },
      );
    }
    if (Buffer.byteLength(line) > this.maxRequestLineBytes) {
      throw new HoshiDictsClientError(
        "REQUEST_TOO_LARGE",
        "HoshiDicts request exceeds the protocol limit",
      );
    }
    this.child.stdin.write(line);
  }

  #handleStdout(child, chunk) {
    if (this.child !== child || this.protocolFailure) {
      return;
    }

    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, bytes]);
    if (
      this.stdoutBuffer.length > this.maxMediaResponseLineBytes &&
      this.stdoutBuffer.indexOf(0x0a) === -1
    ) {
      this.#failProtocol("host emitted an oversized unterminated response");
      return;
    }

    let newlineIndex = this.stdoutBuffer.indexOf(0x0a);
    while (newlineIndex !== -1) {
      let line = this.stdoutBuffer.subarray(0, newlineIndex);
      this.stdoutBuffer = this.stdoutBuffer.subarray(newlineIndex + 1);
      if (line.length > 0 && line[line.length - 1] === 0x0d) {
        line = line.subarray(0, line.length - 1);
      }
      if (line.length > 0) {
        this.#handleResponseLine(line);
        if (this.protocolFailure) {
          return;
        }
      }
      newlineIndex = this.stdoutBuffer.indexOf(0x0a);
    }
  }

  #handleResponseLine(line) {
    if (line.length > this.maxMediaResponseLineBytes) {
      this.#failProtocol("host response exceeds the absolute protocol limit");
      return;
    }

    let message;
    try {
      message = JSON.parse(line.toString("utf8"));
    } catch {
      this.#failProtocol("host emitted malformed JSON");
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      this.#failProtocol("host response must be a JSON object");
      return;
    }

    if (!Object.hasOwn(message, "id")) {
      if (typeof message.event === "string" && line.length <= this.maxResponseLineBytes) {
        this.emit("host-event", message);
        return;
      }
      this.#failProtocol("host emitted an invalid event");
      return;
    }

    const requestId = String(message.id);
    const pending = this.pending.get(requestId);
    if (!pending) {
      const ignoredMethod = this.ignoredResponseIds.get(requestId);
      if (ignoredMethod) {
        const ignoredLimit =
          ignoredMethod === "media.get"
            ? this.maxMediaResponseLineBytes
            : this.maxResponseLineBytes;
        if (line.length > ignoredLimit) {
          this.#failProtocol("ignored host response exceeds the method protocol limit");
          return;
        }
        this.ignoredResponseIds.delete(requestId);
        return;
      }
      this.#failProtocol("host emitted a response for an unknown request id");
      return;
    }

    const maxBytes =
      pending.method === "media.get"
        ? this.maxMediaResponseLineBytes
        : this.maxResponseLineBytes;
    if (line.length > maxBytes) {
      this.#failProtocol("host response exceeds the method protocol limit");
      return;
    }
    if (typeof message.ok !== "boolean") {
      this.#failProtocol("host response is missing the ok field");
      return;
    }

    clearTimeout(pending.timer);
    this.#detachAbortHandler(pending);
    this.pending.delete(requestId);

    if (message.ok) {
      if (!Object.hasOwn(message, "result")) {
        pending.reject(new HoshiDictsProtocolError("host response is missing a result"));
        this.#failProtocol("host response is missing a result");
        return;
      }
      pending.resolve(message.result);
      return;
    }

    const error = message.error;
    if (
      !error ||
      typeof error !== "object" ||
      typeof error.code !== "string" ||
      typeof error.message !== "string"
    ) {
      pending.reject(new HoshiDictsProtocolError("host error response is malformed"));
      this.#failProtocol("host error response is malformed");
      return;
    }
    pending.reject(new HoshiDictsHostError(error.code, error.message));
  }

  #handleStderr(child, chunk) {
    if (this.child !== child) {
      return;
    }
    const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
    this.stderrBuffer += text;
    if (Buffer.byteLength(this.stderrBuffer) > this.maxStderrBytes) {
      const bytes = Buffer.from(this.stderrBuffer);
      this.stderrBuffer = bytes.subarray(bytes.length - this.maxStderrBytes).toString("utf8");
    }
    this.emit("host-stderr", text);
  }

  #handleStreamError(child, error) {
    if (this.child !== child) {
      return;
    }
    this.ready = false;
    this.#rejectAll(
      new HoshiDictsClientError("STREAM_ERROR", "HoshiDicts host stream failed", {
        cause: error,
      }),
    );
    this.#killChild(child);
  }

  #handleChildError(child, error) {
    if (this.child !== child) {
      return;
    }
    const wrapped = new HoshiDictsClientError(
      "SPAWN_FAILED",
      "HoshiDicts host process failed",
      { cause: error },
    );
    this.ready = false;
    this.#rejectAll(wrapped);
    this.emit("host-error", wrapped);
    this.#killChild(child);
  }

  #handleExit(child, code, signal) {
    if (this.child !== child) {
      return;
    }
    this.child = null;
    this.ready = false;

    const error =
      this.protocolFailure || new HoshiDictsHostExitedError(code, signal);
    this.#rejectAll(error);
    this.emit("exit", {
      code,
      signal,
      expected: Boolean(child && child.__hoshiExpectedExit),
      error,
    });
  }

  #failProtocol(message) {
    if (this.protocolFailure) {
      return;
    }
    this.protocolFailure = new HoshiDictsProtocolError(message);
    this.ready = false;
    this.#rejectAll(this.protocolFailure);
    this.emit("protocol-error", this.protocolFailure);
    this.forceKill();
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      this.#detachAbortHandler(pending);
      pending.reject(error);
    }
    this.pending.clear();
  }

  #detachAbortHandler(pending) {
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener("abort", pending.abortHandler);
    }
  }

  #rememberIgnoredResponse(requestId, method) {
    this.ignoredResponseIds.set(requestId, method);
    if (this.ignoredResponseIds.size > MAX_IGNORED_RESPONSE_IDS) {
      const oldest = this.ignoredResponseIds.keys().next().value;
      this.ignoredResponseIds.delete(oldest);
    }
  }

  #validateHello(hello) {
    if (
      !hello ||
      !hello.protocol ||
      hello.protocol.major !== PROTOCOL_VERSION.major ||
      hello.protocol.minor < PROTOCOL_VERSION.minor
    ) {
      throw new HoshiDictsProtocolError("host negotiated an incompatible protocol version");
    }
    if (
      typeof hello.hostVersion !== "string" ||
      typeof hello.hoshidictsCommit !== "string" ||
      !Array.isArray(hello.capabilities)
    ) {
      throw new HoshiDictsProtocolError("host hello response is incomplete");
    }
    if (hello.hoshidictsCommit !== this.expectedHoshiDictsCommit) {
      throw new HoshiDictsProtocolError("host reported an unexpected HoshiDicts source commit");
    }
  }

  getStderr() {
    return this.stderrBuffer;
  }

  async shutdown() {
    const child = this.child;
    if (!child) {
      return;
    }
    child.__hoshiExpectedExit = true;

    const exitPromise = new Promise((resolve) => {
      if (child.exitCode !== null && child.exitCode !== undefined) {
        resolve();
      } else {
        child.once("exit", resolve);
      }
    });

    try {
      if (this.ready) {
        await this.#request(
          "shutdown",
          {},
          {
            timeoutMs: this.shutdownTimeoutMs,
          },
        );
      }
    } catch {
      // Exit is authoritative; shutdown response may race with process teardown.
    }

    const exited = await resolvesWithin(exitPromise, this.forceKillTimeoutMs);
    if (!exited && this.child === child) {
      this.forceKill();
      await resolvesWithin(exitPromise, this.forceKillTimeoutMs);
    }
  }

  async stop() {
    await this.shutdown();
  }

  forceKill() {
    const child = this.child;
    if (!child) {
      return;
    }
    this.#killChild(child);
  }

  #killChild(child) {
    child.__hoshiExpectedExit = true;
    try {
      child.kill("SIGKILL");
    } catch {
      // The process may already have exited.
    }
  }
}

module.exports = {
  HoshiDictsCancelledError,
  HoshiDictsClient,
  HoshiDictsClientError,
  HoshiDictsHostError,
  HoshiDictsHostExitedError,
  HoshiDictsProtocolError,
  HoshiDictsTimeoutError,
  EXPECTED_HOSHIDICTS_COMMIT,
  MAX_MEDIA_RESPONSE_LINE_BYTES,
  MAX_REQUEST_LINE_BYTES,
  MAX_RESPONSE_LINE_BYTES,
  PROTOCOL_VERSION,
  hostExecutableName,
  resolveHoshiDictsExecutable,
};
