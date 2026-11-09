/*
 * How a Settings import takes its turn at the dictionary engine (#578).
 *
 * The offscreen bridge admits one dictionary change at a time and queues the
 * rest, so an import never fails because another change is running. Settings
 * still waits for the engine before each attempt, so the row can say it is
 * waiting and a stuck engine ends the wait. A failed attempt is retried a few
 * times, but only while the library is unchanged: an import whose reply was
 * lost after it committed must not run twice.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const IMPORT_ATTEMPTS = 3;
export const ENGINE_WAIT_TIMEOUT_MS = 30 * 60 * 1000;
export const ENGINE_POLL_MS = 250;
export const ENGINE_POLL_MAX_MS = 2000;
export const RETRY_DELAY_MS = 500;
// Another attempt cannot help: the engine has already retried a memory failure
// with reduced memory, a full disk stays full, and the bridge latches an engine
// that failed to start.
const FINAL_ERROR_CODES = new Set(["import-memory", "import-storage-full", "engine-start-failed"]);

// Resolves after `ms`, or rejects with the signal's reason once it aborts.
export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

// The engine is busy while it starts and while a dictionary change holds its
// lock. A failed or unreadable status is no reason to wait: the import reports
// that failure itself.
export function engineBusy(status) {
  return status?.ok === true && (status.ready !== true || status.mutating === true);
}

// Resolves with the milliseconds waited once the engine is free. Rejects with
// the signal's reason when cancelled, or once the engine has stayed busy for
// `timeoutMs`.
export async function waitForEngine({
  readStatus, onWait = () => {}, signal, wait = sleep, now = Date.now, timeoutMs = ENGINE_WAIT_TIMEOUT_MS,
}) {
  const started = now();
  for (let delay = ENGINE_POLL_MS; ; delay = Math.min(delay * 2, ENGINE_POLL_MAX_MS)) {
    if (signal?.aborted) throw signal.reason;
    const status = await readStatus().catch(() => null);
    const waited = now() - started;
    if (!engineBusy(status)) return waited;
    if (waited >= timeoutMs) {
      throw new Error(`The dictionary engine was still busy after ${Math.round(timeoutMs / 60_000)} minutes.`);
    }
    onWait(waited);
    await wait(Math.min(delay, timeoutMs - waited), signal); // NOSONAR: each poll backs off before the next
  }
}

// An import succeeded only when the engine reports a successful import; a
// thrown request is a failed attempt too.
async function tryImport(attempt, number) {
  try {
    const reply = await attempt(number);
    return { ok: reply?.ok === true && reply.report?.success === true, reply };
  } catch (error) {
    return { ok: false, error };
  }
}

// Runs `attempt(number)`, which resolves the engine's import reply, until it
// succeeds or another attempt is pointless or unsafe, and resolves
// `{ ok, reply | error, attempts }` for the last one. Rejects only when the first
// wait is cancelled or times out, before anything was attempted.
export async function importWithRetries({
  attempt, readRevision, onAttempt = () => {}, onRetry = () => {}, onWait = () => {}, signal, wait = sleep, ...engine
}) {
  let waited = false;
  const turn = () => waitForEngine({ ...engine, signal, wait, onWait: (ms) => { waited = true; onWait(ms); } });
  const revision = () => readRevision().catch(() => null);
  // Read beside the first status poll, and again only if the engine made this
  // import wait: a change that committed meanwhile must not cost the retry.
  const early = revision();
  await turn();
  const before = waited ? await revision() : await early;
  // A Cancel pressed while the poll that found the engine free, or the revision
  // read, was in flight starts nothing either.
  if (signal?.aborted) throw signal.reason;
  for (let number = 1; ; number += 1) {
    onAttempt(number);
    const outcome = { ...await tryImport(attempt, number), attempts: number };
    if (outcome.ok || number >= IMPORT_ATTEMPTS || signal?.aborted
        || FINAL_ERROR_CODES.has(outcome.reply?.errorCode)) return outcome;
    onRetry(number, outcome);
    try {
      await wait(RETRY_DELAY_MS * number, signal);
      // Whatever still runs settles first, perhaps this import after a lost reply.
      await turn();
    } catch {
      return outcome;
    }
    // A library that changed meanwhile may already hold this import, or have
    // made its decision stale; installing beside a title would even commit twice.
    // A Cancel pressed during that poll or read starts no retry.
    if (before === null || await revision() !== before || signal?.aborted) return outcome;
  }
}
