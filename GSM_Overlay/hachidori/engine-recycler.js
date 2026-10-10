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

export function engineWorkerName(lowMemory, dictionaryEntryStorage = "auto", dictionaryIndexStorage = "auto", useLessRamByDefault = true) {
  const mode = lowMemory ? LOW_MEMORY_WORKER_NAME : ENGINE_WORKER_NAME;
  const name = useLessRamByDefault ? mode : `${mode}:full-ram`;
  const entryName = dictionaryEntryStorage === "auto" ? name : `${name}:${dictionaryEntryStorage}`;
  return dictionaryIndexStorage === "auto" ? entryName : `${entryName}:index=${dictionaryIndexStorage}`;
}

export function engineWorkerConfig(name, storageBackend) {
  const lowMemory = name === LOW_MEMORY_WORKER_NAME || name.startsWith(`${LOW_MEMORY_WORKER_NAME}:`);
  const dictionaryEntryStorage = ["paged", "resident"].find((storage) => name.split(":").includes(storage)) ?? "auto";
  return {
    lowMemory,
    useLessRamByDefault: !name.split(":").includes("full-ram"),
    dictionaryEntryStorage,
    dictionaryIndexStorage: ["paged", "resident"].find(storage => name.endsWith(`:index=${storage}`)) ?? "auto",
    pagedDictionaries: lowMemory || dictionaryEntryStorage === "paged"
      || (dictionaryEntryStorage === "auto" && storageBackend === "opfs"),
  };
}

export function createEngineRecycler({ isIdle, restart, setTimer = setTimeout, clearTimer = clearTimeout,
  idleMs = RECYCLE_IDLE_MS }) {
  let desired = false;
  let desiredStorage = "auto";
  let desiredIndexStorage = "auto";
  let desiredLessRam = true;
  // null until the owner reports which worker is running.
  let running = null;
  let runningStorage = "auto";
  let runningIndexStorage = "auto";
  let runningLessRam = true;
  let settledSinceStart = false;
  let timer = null;

  function wanted() {
    return running !== null && (desired !== running || desiredStorage !== runningStorage
      || desiredIndexStorage !== runningIndexStorage || desiredLessRam !== runningLessRam || (desired && settledSinceStart));
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
    restart(desired, desiredStorage, desiredIndexStorage, desiredLessRam);
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
    setDesired(lowMemory, dictionaryEntryStorage = "auto", dictionaryIndexStorage = "auto", useLessRamByDefault = true) {
      desired = lowMemory === true;
      desiredStorage = dictionaryEntryStorage;
      desiredIndexStorage = dictionaryIndexStorage;
      desiredLessRam = useLessRamByDefault;
      reconsider();
    },
    // The mode the worker that is now serving requests was created with.
    setRunning(lowMemory, dictionaryEntryStorage = "auto", dictionaryIndexStorage = "auto", useLessRamByDefault = true) {
      running = lowMemory === true;
      runningStorage = dictionaryEntryStorage;
      runningIndexStorage = dictionaryIndexStorage;
      runningLessRam = useLessRamByDefault;
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
