// SPDX-License-Identifier: GPL-3.0-or-later
import { ankiIndexSource, ankiWordKey } from "./anki-index.js";

export const ANKI_INDEX_KEY = "ankiDuplicateIndex";
export const ANKI_INDEX_ALARM = "hachidori-anki-index";
export const ANKI_INDEX_REFRESH_MS = 30 * 60 * 1000;

const positiveId = value => Number.isSafeInteger(value) && value > 0;
const compare = (left, right) => Number(left > right) - Number(left < right);

function normalizedRow(value) {
  if (!Array.isArray(value) || value.length !== 3 || typeof value[0] !== "string" || !value[0]
      || typeof value[1] !== "boolean" || !Array.isArray(value[2]) || !value[2].every(positiveId)) return null;
  const noteIds = [...new Set(value[2])].sort((left, right) => left - right);
  if (!noteIds.length) return null;
  return [value[0], value[1], noteIds];
}

function normalizedRows(value) {
  if (!Array.isArray(value)) return null;
  const rows = value.map(normalizedRow);
  if (rows.some(row => row === null)) return null;
  rows.sort(([left], [right]) => compare(left, right));
  if (rows.some((row, index) => index > 0 && rows[index - 1][0] === row[0])) return null;
  return rows;
}

function cacheState(value) {
  const state = value?.version === 1 ? value : {};
  const snapshot = state.snapshot;
  const rows = normalizedRows(snapshot?.rows);
  const attempt = state.attempt;
  return {
    version: 1,
    configurationRevision: Number.isInteger(state.configurationRevision) ? state.configurationRevision : 0,
    rowRevision: Number.isInteger(state.rowRevision) ? state.rowRevision : 0,
    snapshot: typeof snapshot?.sourceKey === "string" && Number.isFinite(snapshot.refreshedAt) && rows !== null
      ? { sourceKey: snapshot.sourceKey, refreshedAt: snapshot.refreshedAt, rows } : null,
    attempt: typeof attempt?.sourceKey === "string" && Number.isFinite(attempt.startedAt)
      ? {
        sourceKey: attempt.sourceKey,
        startedAt: attempt.startedAt,
        ...(Number.isFinite(attempt.finishedAt) ? { finishedAt: attempt.finishedAt } : {}),
      } : null,
  };
}

async function sourceFor(options) {
  return ankiIndexSource(options.anki);
}

export async function ankiIndexConfigurationChange(previous, next, value) {
  const [before, after] = await Promise.all([sourceFor(previous), sourceFor(next)]);
  if (before?.key === after?.key) return undefined;
  const state = cacheState(value);
  return { ...state, configurationRevision: state.configurationRevision + 1, attempt: null };
}

function rowMap(snapshot) {
  return new Map((snapshot?.rows ?? []).map(([word, mature, noteIds]) =>
    [word, { mature, noteIds: [...noteIds] }]));
}

function rowsFromMap(rows) {
  return [...rows].sort(([left], [right]) => compare(left, right))
    .map(([word, row]) => [word, row.mature, [...row.noteIds]]);
}

function sameRow(left, right) {
  return left?.mature === right?.mature
    && JSON.stringify(left?.noteIds ?? null) === JSON.stringify(right?.noteIds ?? null);
}

function normalizedLookup(value, wordKey) {
  if (!value || value.wordKey !== wordKey || typeof value.mature !== "boolean"
      || !Array.isArray(value.noteIds) || !value.noteIds.every(positiveId)) {
    throw new Error("Anki returned an invalid duplicate lookup result.");
  }
  return {
    wordKey,
    mature: value.mature,
    noteIds: [...new Set(value.noteIds)].sort((left, right) => left - right),
  };
}

function ownsAttempt(current, source, token) {
  return current.attempt?.sourceKey === source.key && current.attempt.startedAt === token.startedAt;
}

export function createAnkiDuplicateIndex({
  fetchRows,
  lookupLive,
  readOptions,
  readState,
  updateState,
  alarms,
  now = Date.now,
  reportError = error => console.warn("hachidori: Anki index refresh failed:", error),
}) {
  let snapshot = null;
  let rows = new Map();
  let active = null;
  // The reservation this worker made most recently. A stored attempt that has
  // no recorded outcome and was not reserved here belongs to a worker that
  // stopped mid-pull (host torn down, worker restarted): it is due now rather
  // than at its 30-minute mark, which no alarm may be armed to reach.
  let ownStartedAt = null;
  let controlTail = Promise.resolve();
  let suspended = false;
  const liveLookups = new Map();
  const hydrate = readState().then(value => {
    snapshot = cacheState(value).snapshot;
    rows = rowMap(snapshot);
  }).catch(reportError);

  function install(value) {
    snapshot = cacheState(value).snapshot;
    rows = rowMap(snapshot);
  }

  function control(job) {
    const run = controlTail.then(job);
    controlTail = run.catch(() => {});
    return run;
  }

  async function schedule(when) {
    const existing = await alarms.get(ANKI_INDEX_ALARM);
    if (when === null) {
      if (existing) await alarms.clear(ANKI_INDEX_ALARM);
    } else if (!existing || existing.scheduledTime !== when || existing.periodInMinutes !== undefined) {
      await alarms.create(ANKI_INDEX_ALARM, { when });
    }
  }

  async function updateRow(source, wordKey, change) {
    await hydrate;
    return control(async () => {
      let changed = false;
      const saved = await updateState(async ({ options, state: value }) => {
        const current = cacheState(value);
        const currentSource = await sourceFor(options);
        if (currentSource?.key !== source.key) return;
        const currentRows = current.snapshot?.sourceKey === source.key ? rowMap(current.snapshot) : new Map();
        const previous = currentRows.get(wordKey) ?? null;
        const next = change(previous);
        if (next === null) currentRows.delete(wordKey);
        else currentRows.set(wordKey, {
          mature: next.mature,
          noteIds: [...new Set(next.noteIds)].sort((left, right) => left - right),
        });
        if (sameRow(previous, next)) return;
        changed = true;
        return {
          ...current,
          rowRevision: current.rowRevision + 1,
          snapshot: {
            sourceKey: source.key,
            refreshedAt: current.snapshot?.sourceKey === source.key ? current.snapshot.refreshedAt : now(),
            rows: rowsFromMap(currentRows),
          },
        };
      });
      if (changed) install(saved);
    });
  }

  async function pull(source, token) {
    try {
      const nextRows = normalizedRows(await fetchRows(source));
      if (nextRows === null) throw new Error("Anki returned an invalid index snapshot.");
      await control(async () => {
        let committed = false;
        const saved = await updateState(async ({ options, state: value }) => {
          const current = cacheState(value);
          const currentSource = await sourceFor(options);
          if (current.configurationRevision !== token.configurationRevision
              || currentSource?.key !== source.key
              || !ownsAttempt(current, source, token)) return;
          // A repaired miss or confirmed write after this pull began must not
          // be erased by a response that took its snapshot before that change.
          if (current.rowRevision !== token.rowRevision) {
            return { ...current, attempt: null };
          }
          committed = true;
          return {
            ...current,
            rowRevision: current.rowRevision + 1,
            snapshot: { sourceKey: source.key, refreshedAt: now(), rows: nextRows },
            attempt: { ...current.attempt, finishedAt: now() },
          };
        });
        if (committed) install(saved);
      });
    } catch (error) {
      reportError(error);
      // A pull that ran to failure keeps its 30-minute backoff; only a pull
      // that never records an outcome is retried by the next worker start.
      await updateState(async ({ state: value }) => {
        const current = cacheState(value);
        if (!ownsAttempt(current, source, token) || current.attempt.finishedAt !== undefined) return;
        return { ...current, attempt: { ...current.attempt, finishedAt: now() } };
      }).catch(reportError);
    } finally {
      await control(() => { if (active?.token === token) active = null; });
      // A configuration or row change during the pull may require an immediate
      // replacement. A successful or failed current pull remains due in 30 min.
      void reconcile();
    }
  }

  function refreshDue(attempt, source) {
    if (attempt?.sourceKey !== source.key) return 0;
    if (attempt.finishedAt === undefined && attempt.startedAt !== ownStartedAt) return 0;
    return attempt.startedAt + ANKI_INDEX_REFRESH_MS;
  }

  async function startDueRefresh() {
    await hydrate;
    if (suspended) {
      await schedule(null);
      return null;
    }
    const source = await sourceFor(await readOptions());
    if (!source) {
      await schedule(null);
      return null;
    }
    if (active) return { promise: active.promise };
    const state = cacheState(await readState());
    const due = refreshDue(state.attempt, source);
    if (due > now()) {
      await schedule(due);
      return null;
    }

    const token = { startedAt: now() };
    let reserved = false;
    await updateState(async ({ options, state: value }) => {
      const current = cacheState(value);
      const currentSource = await sourceFor(options);
      if (currentSource?.key !== source.key) return;
      if (refreshDue(current.attempt, source) > now()) return;
      reserved = true;
      token.configurationRevision = current.configurationRevision;
      token.rowRevision = current.rowRevision;
      return { ...current, attempt: { sourceKey: source.key, startedAt: token.startedAt } };
    });
    if (!reserved) return null;
    ownStartedAt = token.startedAt;
    await schedule(token.startedAt + ANKI_INDEX_REFRESH_MS);
    const promise = pull(source, token);
    active = { token, promise };
    return { promise };
  }

  function reconcile() {
    return control(startDueRefresh).then(job => job?.promise).catch(reportError);
  }

  async function suspend() {
    suspended = true;
    await hydrate;
    // Let a refresh which already reserved its pull publish `active`, then
    // wait outside the control queue so its completion can use that queue.
    await control(async () => {});
    await active?.promise;
    await schedule(null);
  }

  function resume() {
    suspended = false;
    return reconcile();
  }

  async function local(config, expression) {
    const [source, wordKey] = await Promise.all([ankiIndexSource(config), Promise.resolve(ankiWordKey(expression))]);
    if (source === null || wordKey === null) {
      return { source, wordKey, mature: false, noteIds: [], cached: false };
    }
    await hydrate;
    const cached = snapshot?.sourceKey === source.key ? rows.get(wordKey) : null;
    return cached
      ? { source, wordKey, mature: cached.mature, noteIds: [...cached.noteIds], cached: true }
      : { source, wordKey, mature: false, noteIds: [], cached: false };
  }

  async function find(config, expression, invoke, force) {
    const cached = await local(config, expression);
    const { source, wordKey } = cached;
    if (source === null || wordKey === null) {
      return { wordKey, mature: false, noteIds: [], cached: false };
    }
    if (!force && cached.cached) {
      return { wordKey, mature: cached.mature, noteIds: cached.noteIds, cached: true };
    }
    const liveKey = `${source.key}\n${wordKey}\n${force ? "repair" : "lookup"}`;
    let operation = liveLookups.get(liveKey);
    if (!operation) {
      operation = Promise.resolve(lookupLive(source, expression, invoke))
        .then(value => normalizedLookup(value, wordKey))
        .then(async value => {
          if (value.noteIds.length) {
            await updateRow(source, wordKey, () => ({ mature: value.mature, noteIds: value.noteIds }));
          } else if (force) {
            await updateRow(source, wordKey, () => null);
          }
          return value;
        })
        .finally(() => liveLookups.delete(liveKey));
      liveLookups.set(liveKey, operation);
    }
    return { ...await operation, cached: false };
  }

  return {
    reconcile,
    suspend,
    resume,
    source: ankiIndexSource,
    async peek(config, expression) {
      const result = await local(config, expression);
      return { wordKey: result.wordKey, mature: result.mature, noteIds: result.noteIds, cached: result.cached };
    },
    lookup: (config, expression, invoke) => find(config, expression, invoke, false),
    repair: (config, expression, invoke) => find(config, expression, invoke, true),
    async recordWrite(config, expression, noteId, { mature = false } = {}) {
      if (!positiveId(noteId)) throw new Error("Anki returned an invalid written note ID.");
      const [source, wordKey] = await Promise.all([ankiIndexSource(config), Promise.resolve(ankiWordKey(expression))]);
      if (source === null || wordKey === null) return;
      await updateRow(source, wordKey, previous => ({
        mature: previous?.mature ?? mature,
        noteIds: [...(previous?.noteIds ?? []), noteId],
      }));
    },
    async has(config, expression) {
      const [source, wordKey] = await Promise.all([ankiIndexSource(config), Promise.resolve(ankiWordKey(expression))]);
      if (source === null || wordKey === null) return false;
      await hydrate;
      return snapshot?.sourceKey === source.key && rows.get(wordKey)?.mature === true;
    },
  };
}
