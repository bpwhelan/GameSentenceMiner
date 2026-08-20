const POINTER_PROTOCOL_MINIMUM_VERSION = 3;
const POINTER_CONNECTION_DURABLE_DOWN_MS = 1500;

function createLinuxX11PointerProtocolState({
  minimumProtocolVersion = POINTER_PROTOCOL_MINIMUM_VERSION,
} = {}) {
  const versionByUrl = new Map();
  let url = null;
  let protocolSupported = null;

  return {
    connect(nextUrl) {
      url = nextUrl || null;
      protocolSupported = url && versionByUrl.has(url)
        ? versionByUrl.get(url) >= minimumProtocolVersion
        : null;
      return protocolSupported;
    },
    reportServiceInfo(pointerQueryProtocolVersion) {
      const reportedVersion = Number(pointerQueryProtocolVersion);
      protocolSupported = reportedVersion >= minimumProtocolVersion;
      if (url) versionByUrl.set(url, reportedVersion);
      return protocolSupported;
    },
    disconnect({ clearUrl = false } = {}) {
      if (clearUrl) {
        url = null;
        protocolSupported = null;
      }
      return protocolSupported;
    },
    get url() { return url; },
    get protocolSupported() { return protocolSupported; },
  };
}

function resolveLinuxX11PointerRead({
  protocolSupported = null,
  hasSuccessfulQuery = false,
  hasFreshPosition = false,
  fallbackDeadlineReached = false,
} = {}) {
  if (hasFreshPosition) return { source: 'server', fallbackReason: null };
  if (protocolSupported === false) return { source: 'fallback', fallbackReason: 'unsupported' };
  // Electron's cursor sample is the least-bad source until QueryPointer has
  // proved that this endpoint works. Never make a previously working native
  // X11 overlay permanently click-through while a helper is starting.
  if (!hasSuccessfulQuery) return { source: 'fallback', fallbackReason: 'starting' };
  if (fallbackDeadlineReached) return { source: 'fallback', fallbackReason: 'down' };
  return { source: 'suppressed', fallbackReason: null };
}

function createLinuxX11PointerFallbackWarningLogger({ warn = () => {} } = {}) {
  let fallbackState = null;
  return {
    update(nextState, reason) {
      if (fallbackState === nextState) return false;
      fallbackState = nextState;
      if (!nextState) return false;
      warn(reason);
      return true;
    },
    get state() { return fallbackState; },
  };
}

function createLinuxX11PointerFallbackDeadline({
  now = Date.now,
  delayMs = POINTER_CONNECTION_DURABLE_DOWN_MS,
} = {}) {
  let deadlineAt = null;
  return {
    beginFailure() {
      if (deadlineAt === null) deadlineAt = now() + delayMs;
      return deadlineAt;
    },
    markSuccess() { deadlineAt = null; },
    reset() { deadlineAt = null; },
    hasReached() { return deadlineAt !== null && now() >= deadlineAt; },
    get deadlineAt() { return deadlineAt; },
  };
}

function decodeLinuxX11PointerMessage(rawMessage) {
  let message;
  try {
    message = typeof rawMessage === 'string' ? JSON.parse(rawMessage) : rawMessage;
  } catch {
    return { kind: 'invalid' };
  }
  if (!message || typeof message !== 'object') return { kind: 'invalid' };
  if (message.type === 'service_info') {
    return { kind: 'service-info', pointerQueryProtocolVersion: Number(message.pointerQueryProtocolVersion) };
  }
  if (message.type !== 'pointer_position') return { kind: 'other' };
  const requestId = Number.isSafeInteger(message.requestId) && message.requestId >= 0
    ? message.requestId
    : null;
  if (message.ok !== true) return { kind: 'pointer-response', position: null, requestId };
  const x = Number(message.x);
  const y = Number(message.y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) {
    return { kind: 'pointer-response', position: null, requestId };
  }
  return { kind: 'pointer-response', position: { x, y }, requestId };
}

function createLinuxX11PointerController({
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  requestTimeoutMs = 500,
  cacheTtlMs = 500,
  onTimeout = () => {},
} = {}) {
  let inFlight = false;
  let inFlightRequestId = null;
  let nextRequestId = 0;
  let requestTimer = null;
  let lastPosition = null;
  let lastPositionAt = 0;
  const clearInFlight = () => {
    inFlight = false;
    inFlightRequestId = null;
    if (requestTimer) {
      clearTimer(requestTimer);
      requestTimer = null;
    }
  };
  return {
    get inFlight() { return inFlight; },
    request(socketOpen, send) {
      if (!socketOpen || inFlight) return false;
      inFlight = true;
      const requestId = nextRequestId++;
      inFlightRequestId = requestId;
      requestTimer = setTimer(() => {
        requestTimer = null;
        if (!inFlight || inFlightRequestId !== requestId) return;
        inFlight = false;
        inFlightRequestId = null;
        onTimeout();
      }, requestTimeoutMs);
      try { send(requestId); return true; } catch (error) { clearInFlight(); throw error; }
    },
    handleMessage(rawMessage) {
      const message = decodeLinuxX11PointerMessage(rawMessage);
      if (message.kind !== 'pointer-response') return message;
      const receivedAt = now();
      // Protocol v3 requires an exact ID on every success and failure. An
      // id-less/late failure must not clear a newer in-flight request.
      if (!inFlight || message.requestId !== inFlightRequestId) {
        return { ...message, accepted: false, receivedAt };
      }
      clearInFlight();
      if (message.position) {
        lastPosition = message.position;
        lastPositionAt = receivedAt;
      }
      return { ...message, accepted: true, receivedAt };
    },
    getFreshPosition() {
      if (!lastPosition || now() - lastPositionAt > cacheTtlMs) {
        lastPosition = null;
        lastPositionAt = 0;
        return null;
      }
      return lastPosition;
    },
    reset() {
      clearInFlight();
      lastPosition = null;
      lastPositionAt = 0;
      nextRequestId = 0;
    },
    disconnect() { clearInFlight(); },
    teardown() { this.reset(); },
  };
}

function toDipPointer(position, screenToDipPoint) {
  if (!position || typeof screenToDipPoint !== 'function') return position;
  const converted = screenToDipPoint(position);
  return Number.isFinite(converted && converted.x) && Number.isFinite(converted && converted.y)
    ? { x: converted.x, y: converted.y }
    : position;
}

function shouldRequireLinuxX11PointerServer(options = {}) {
  return options.capabilityEnabled === true && !!(
    options.pointerQueryNeeded ||
    options.hasSocket ||
    options.hasUrl
  );
}

module.exports = {
  createLinuxX11PointerProtocolState,
  resolveLinuxX11PointerRead,
  createLinuxX11PointerFallbackWarningLogger,
  createLinuxX11PointerFallbackDeadline,
  createLinuxX11PointerController,
  shouldRequireLinuxX11PointerServer,
  toDipPointer,
};
