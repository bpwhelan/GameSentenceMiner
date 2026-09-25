/*
 * Decides when offscreen.js restarts the engine worker.
 *
 * WebAssembly linear memory never shrinks, so the worker keeps whatever an
 * import or rebuild peaked at. Low memory mode reclaims that by replacing the
 * worker once the change has settled and nothing is in flight; a worker whose
 * mode no longer matches the option is replaced the same way. Pure: the owner
 * supplies the idle predicate, the restart, and the timer, so the rule is
 * testable without a worker.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const RECYCLE_IDLE_MS = 2000;

// Worker names offscreen.js creates the engine under. The name is fixed at
// creation and engine-worker-runtime.js reads it, so the pthread pool size and
// the import threading it implies cannot disagree however the option is
// toggled afterwards.
export const ENGINE_WORKER_NAME = "hoshidicts-engine";
export const LOW_MEMORY_WORKER_NAME = "hoshidicts-engine:low-memory";

export function createEngineRecycler({ isIdle, restart, setTimer = setTimeout, clearTimer = clearTimeout,
  idleMs = RECYCLE_IDLE_MS }) {
  let desired = false;
  // null until the owner reports which worker is running.
  let running = null;
  let settledSinceStart = false;
  let timer = null;

  function wanted() {
    return running !== null && (desired !== running || (desired && settledSinceStart));
  }

  function fire() {
    timer = null;
    if (!wanted()) return;
    if (!isIdle()) {
      schedule();
      return;
    }
    settledSinceStart = false;
    running = null;
    restart(desired);
  }

  function schedule() {
    if (timer !== null) clearTimer(timer);
    timer = setTimer(fire, idleMs);
  }

  function reconsider() {
    if (wanted()) schedule();
    else if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  }

  return {
    // The option as stored.
    setDesired(lowMemory) {
      desired = lowMemory === true;
      reconsider();
    },
    // The mode the worker that is now serving requests was created with.
    setRunning(lowMemory) {
      running = lowMemory === true;
      settledSinceStart = false;
      reconsider();
    },
    // A mutation, import, or staged mutation finished (successfully or not).
    noteMutationSettled() {
      settledSinceStart = true;
      reconsider();
    },
    // A request finished; the idle window starts over.
    noteIdle() {
      if (wanted()) schedule();
    },
  };
}
