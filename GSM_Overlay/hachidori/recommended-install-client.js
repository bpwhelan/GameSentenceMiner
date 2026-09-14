// Observe the same offscreen installation from startup, Settings or a linked browser.
// SPDX-License-Identifier: GPL-3.0-or-later
export function createRecommendedInstallClient({ send, onChange, onError, timers = globalThis }) {
  let run = null;
  let pending = null;
  let failed = false;
  let timer = null;
  let stopped = false;

  function adopt(snapshot) {
    if (run !== null && run.runId === snapshot.runId && snapshot.sequence <= run.sequence) return false;
    run = {
      runId: snapshot.runId ?? null,
      sequence: Number(snapshot.sequence) || 0,
      finished: snapshot.finished !== false,
      entries: Array.isArray(snapshot.entries) ? snapshot.entries : [],
    };
    return true;
  }

  // Local progress resets this timer. Linked pages, and pages whose offscreen
  // host restarted, observe the authoritative snapshot after a quiet interval.
  function watch() {
    timers.clearTimeout(timer);
    timer = null;
    if (stopped || run?.finished !== false) return;
    timer = timers.setTimeout(async () => {
      timer = null;
      if (pending !== null) { watch(); return; }
      try {
        const before = run;
        const reply = await send([]);
        if (!stopped && reply?.ok === true && (run === before || run?.runId === reply.runId) && adopt(reply)) onChange();
      } catch { /* A quiet installer is observed again without starting work. */ }
      watch();
    }, 4000);
  }

  function request(sourceIds = []) {
    stopped = false;
    if (pending !== null) return sourceIds.length > 0 && !pending.installing
      ? pending.promise.then(() => request(sourceIds)) : pending.promise;
    failed = false;
    const before = run;
    const promise = Promise.resolve().then(() => send(sourceIds)).then(reply => {
      if (stopped) return;
      if (reply?.ok !== true) throw new Error(reply?.error || "The dictionary installer did not reply.");
      if (run === before || run?.runId === reply.runId) adopt(reply);
    }).catch(error => {
      if (stopped) return;
      failed = true;
      onError(error);
    }).finally(() => {
      pending = null;
      if (!stopped) { watch(); onChange(); }
    });
    pending = { promise, installing: sourceIds.length > 0 };
    return promise;
  }

  return {
    get run() { return run; },
    get pending() { return pending; },
    get failed() { return failed; },
    request,
    receive(message) {
      if (stopped || message?.target !== "hachidori-setup-events" || message.type !== "hd_setup_progress"
          || !Number.isFinite(message.sequence)
          || (run?.finished === false && message.runId !== run.runId)) return;
      if (adopt(message)) { watch(); onChange(); }
    },
    stop() { stopped = true; timers.clearTimeout(timer); timer = null; },
  };
}
