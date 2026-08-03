function createLinuxX11BoundsRepairController({
  getBounds,
  getExpectedBounds,
  repair,
  now = Date.now,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  warn = () => {},
  maxRepairs = 4,
  maxElapsedMs = 5000,
  baseDelayMs = 50,
  maxDelayMs = 1000,
  selfEventSettleMs = 250,
}) {
  let timer = null;
  let repairCount = 0;
  let budgetStartedAt = null;
  let suppressEventsUntil = 0;
  let gaveUp = false;
  let applying = false;
  let disposed = false;

  const matches = (first, second) => first && second &&
    first.x === second.x && first.y === second.y &&
    first.width === second.width && first.height === second.height;
  const clearScheduled = () => {
    if (timer) clearTimer(timer);
    timer = null;
  };
  const attempt = (reason) => {
    timer = null;
    if (gaveUp || disposed) return;
    if (matches(getBounds(), getExpectedBounds())) {
      return;
    }
    const attemptAt = now();
    if (budgetStartedAt === null) budgetStartedAt = attemptAt;
    if (repairCount >= maxRepairs || attemptAt - budgetStartedAt >= maxElapsedMs) {
      gaveUp = true;
      warn(`[LinuxX11Bounds] Giving up after ${repairCount} repairs (${reason}); waiting for a display change.`);
      return;
    }
    repairCount += 1;
    applying = true;
    try { repair(reason); } finally {
      applying = false;
      // Electron delivers move/resize asynchronously after setBounds. Ignore
      // those induced events and perform one settled verification ourselves.
      suppressEventsUntil = now() + selfEventSettleMs;
      schedule("settled-verification", selfEventSettleMs);
    }
  };
  const schedule = (reason, delayMs) => {
    if (gaveUp || disposed || timer) return;
    const delay = delayMs == null
      ? Math.min(baseDelayMs * (2 ** repairCount), maxDelayMs)
      : delayMs;
    timer = setTimer(() => attempt(reason), delay);
  };

  return {
    onBoundsEvent(eventName) {
      if (applying || gaveUp || disposed || now() < suppressEventsUntil) return;
      if (matches(getBounds(), getExpectedBounds())) return;
      schedule(eventName);
    },
    onShow() { schedule("show", 0); },
    reset() {
      if (disposed) return;
      clearScheduled();
      repairCount = 0;
      budgetStartedAt = null;
      suppressEventsUntil = 0;
      gaveUp = false;
    },
    teardown() {
      disposed = true;
      clearScheduled();
    },
    get state() {
      return {
        repairCount,
        budgetStartedAt,
        suppressEventsUntil,
        gaveUp,
        disposed,
        applying,
        scheduled: !!timer,
        now: now(),
      };
    },
  };
}

module.exports = { createLinuxX11BoundsRepairController };
