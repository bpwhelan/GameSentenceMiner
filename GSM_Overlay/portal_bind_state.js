function createPortalBindPendingTracker(options = {}) {
  const watchdogMs = Number.isFinite(options.watchdogMs) && options.watchdogMs > 0
    ? options.watchdogMs
    : 30_000;
  const schedule = options.schedule || setTimeout;
  const cancel = options.cancel || clearTimeout;
  const onChange = typeof options.onChange === "function" ? options.onChange : () => {};
  const onTimeout = typeof options.onTimeout === "function" ? options.onTimeout : () => {};

  let pending = false;
  let watchdog = null;

  function clearWatchdog() {
    if (watchdog !== null) {
      cancel(watchdog);
      watchdog = null;
    }
  }

  function resolve(reason, details = {}) {
    if (!pending) return false;
    pending = false;
    clearWatchdog();
    onChange(false, { reason, ...details });
    return true;
  }

  function enter(details = {}) {
    if (pending) return false;
    pending = true;
    onChange(true, details);
    watchdog = schedule(() => {
      watchdog = null;
      if (!pending) return;
      onTimeout();
      pending = false;
      onChange(false, { reason: "watchdog-timeout", timedOut: true });
    }, watchdogMs);
    return true;
  }

  function handle(message = {}) {
    if (message.state === "pending") {
      return enter({ reason: "server-pending" });
    }
    if (message.state === "resolved") {
      return resolve("server-resolved", { ok: message.ok === true });
    }
    return false;
  }

  return {
    handle,
    reset: (reason = "reset") => resolve(reason, { reset: true }),
    isPending: () => pending,
  };
}

module.exports = { createPortalBindPendingTracker };
