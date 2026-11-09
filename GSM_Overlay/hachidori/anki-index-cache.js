// SPDX-License-Identifier: GPL-3.0-or-later
import { ankiIndexSource, ankiWordKey } from "./anki-index.js";
import { ankiLanguageConfig } from "./anki-setup.js";

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

function normalizedSnapshot(snapshot) {
  const rows = normalizedRows(snapshot?.rows);
  return typeof snapshot?.sourceKey === "string" && Number.isFinite(snapshot.refreshedAt) && rows !== null
    ? { sourceKey: snapshot.sourceKey, refreshedAt: snapshot.refreshedAt, rows } : null;
}

function normalizedAttempt(attempt) {
  return typeof attempt?.sourceKey === "string" && Number.isFinite(attempt.startedAt)
    ? {
      sourceKey: attempt.sourceKey,
      startedAt: attempt.startedAt,
      ...(Number.isFinite(attempt.finishedAt) ? { finishedAt: attempt.finishedAt } : {}),
    } : null;
}

// Valid entries, one per source key: the first one stays.
function bySource(values, normalize) {
  const keys = new Set();
  return values.map(normalize).filter(entry => entry !== null && !keys.has(entry.sourceKey) && keys.add(entry.sourceKey));
}

const entryFor = (entries, key) => entries.find(entry => entry.sourceKey === key) ?? null;
const withEntry = (entries, key, entry) => [...entries.filter(item => item.sourceKey !== key), ...(entry ? [entry] : [])];

// The stored record holds today's one `snapshot` and one `attempt` while the
// profiles' first Templates name at most one source, and one of each per
// source key (`snapshots`, `attempts`) once they name two (docs/languages.md
// 4.3 and 12). Its two revisions cover every snapshot.
function cacheState(value) {
  const state = value?.version === 1 ? value : {};
  const multi = Array.isArray(state.snapshots) || Array.isArray(state.attempts);
  const listed = name => (Array.isArray(state[name]) ? state[name] : []);
  return {
    configurationRevision: Number.isInteger(state.configurationRevision) ? state.configurationRevision : 0,
    rowRevision: Number.isInteger(state.rowRevision) ? state.rowRevision : 0,
    multi,
    snapshots: bySource(multi ? listed("snapshots") : [state.snapshot], normalizedSnapshot),
    attempts: bySource(multi ? listed("attempts") : [state.attempt], normalizedAttempt),
  };
}

// The record to store for the current sources, `keys` in profile order. One
// source keeps today's record, which also keeps a snapshot no Template uses
// any more until the next pull replaces it; several keep exactly the current
// sources' entries, so a source no profile's first Template uses leaves.
function storedState(state, keys) {
  const { configurationRevision, rowRevision } = state;
  if (keys.length > 1) {
    const current = entries => keys.flatMap(key => entries.filter(entry => entry.sourceKey === key));
    return { version: 1, configurationRevision, rowRevision,
      snapshots: current(state.snapshots), attempts: current(state.attempts) };
  }
  const only = entries => entryFor(entries, keys[0]) ?? (state.multi ? null : entries[0] ?? null);
  return { version: 1, configurationRevision, rowRevision, snapshot: only(state.snapshots), attempt: only(state.attempts) };
}

// [profile id, its first Template's source or null] for every profile, each
// keyed with its language's note-type families (docs/languages.md 12); an
// options record without profiles is the Japanese profile, as today.
async function profileSources(options) {
  const layer = globalThis.HDReaderOptions;
  const list = layer.hasProfiles(options) ? layer.profiles(options) : [{ id: layer.JAPANESE_PROFILE_ID, language: "ja" }];
  return Promise.all(list.map(async profile => [profile.id,
    await ankiIndexSource(ankiLanguageConfig(layer.projectOptions(options, profile.id).anki, profile.language))]));
}

/**
 * Every profile's first-Template source, once per key, in profile order: the
 * sources the index keeps a snapshot of.
 * @returns {Promise<Map<string, object>>}
 */
export async function ankiIndexSources(options) {
  const sources = new Map();
  for (const [, source] of await profileSources(options)) {
    if (source !== null && !sources.has(source.key)) sources.set(source.key, source);
  }
  return sources;
}

const sourceKeys = async options => [...(await ankiIndexSources(options)).keys()];

// Called in the storage queue with the options records before and after a
// write. A change of any profile's first-Template source, compared profile by
// profile, invalidates: the configuration revision moves, and the snapshot of
// a source no profile uses any more goes. One source's record also drops its
// attempt so the new source is pulled at once, as it always has; with several
// sources, each keeps its own schedule.
export async function ankiIndexConfigurationChange(previous, next, value) {
  const [before, after] = await Promise.all([profileSources(previous), profileSources(next)]);
  const keyOf = new Map(before.map(([id, source]) => [id, source?.key ?? null]));
  const nextKeys = new Map(after.map(([id, source]) => [id, source?.key ?? null]));
  if ([...new Set([...keyOf.keys(), ...nextKeys.keys()])]
    .every(id => (keyOf.get(id) ?? null) === (nextKeys.get(id) ?? null))) return undefined;
  const state = cacheState(value);
  const keys = [...new Set([...nextKeys.values()].filter(key => key !== null))];
  const changed = { ...state, configurationRevision: state.configurationRevision + 1 };
  return storedState(!state.multi && keys.length <= 1 ? { ...changed, attempts: [] } : changed, keys);
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
  return entryFor(current.attempts, source.key)?.startedAt === token.startedAt;
}

export function createAnkiDuplicateIndex({
  fetchRows,
  lookupLive,
  lookupLiveMany,
  readOptions,
  readState,
  updateState,
  alarms,
  now = Date.now,
  reportError = error => console.warn("hachidori: Anki index refresh failed:", error),
}) {
  // Each source's rows by source key; every row change installs them all with
  // the one row revision that covers them.
  let snapshots = new Map();
  let rowRevision = 0;
  // One pull at a time; the next due source follows it.
  let active = null;
  // The reservation this worker made most recently for each source. A stored
  // attempt that has no recorded outcome and was not reserved here belongs to
  // a worker that stopped mid-pull (host torn down, worker restarted): it is
  // due now rather than at its 30-minute mark, which no alarm may be armed to reach.
  const ownStarted = new Map();
  let controlTail = Promise.resolve();
  let suspended = false;
  const liveLookups = new Map();
  const hydrate = readState().then(install).catch(reportError);

  function install(value) {
    const state = cacheState(value);
    snapshots = new Map(state.snapshots.map(snapshot => [snapshot.sourceKey, rowMap(snapshot)]));
    rowRevision = state.rowRevision;
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
        const keys = await sourceKeys(options);
        if (!keys.includes(source.key)) return;
        const snapshot = entryFor(current.snapshots, source.key);
        const currentRows = rowMap(snapshot);
        const previous = currentRows.get(wordKey) ?? null;
        const next = change(previous);
        if (next === null) currentRows.delete(wordKey);
        else currentRows.set(wordKey, {
          mature: next.mature,
          noteIds: [...new Set(next.noteIds)].sort((left, right) => left - right),
        });
        if (sameRow(previous, next)) return;
        changed = true;
        return storedState({
          ...current,
          rowRevision: current.rowRevision + 1,
          snapshots: withEntry(current.snapshots, source.key, {
            sourceKey: source.key,
            refreshedAt: snapshot?.refreshedAt ?? now(),
            rows: rowsFromMap(currentRows),
          }),
        }, keys);
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
          const keys = await sourceKeys(options);
          // A source that left and came back has a new reservation, so a pull
          // from before either change cannot own it.
          if (!keys.includes(source.key) || !ownsAttempt(current, source, token)) return;
          // A repaired miss or confirmed write after this pull began must not
          // be erased by a response that took its snapshot before that change.
          if (current.rowRevision !== token.rowRevision) {
            return storedState({ ...current, attempts: withEntry(current.attempts, source.key, null) }, keys);
          }
          committed = true;
          return storedState({
            ...current,
            rowRevision: current.rowRevision + 1,
            snapshots: withEntry(current.snapshots, source.key,
              { sourceKey: source.key, refreshedAt: now(), rows: nextRows }),
            attempts: withEntry(current.attempts, source.key,
              { ...entryFor(current.attempts, source.key), finishedAt: now() }),
          }, keys);
        });
        if (committed) install(saved);
      });
    } catch (error) {
      reportError(error);
      // A pull that ran to failure keeps its 30-minute backoff; only a pull
      // that never records an outcome is retried by the next worker start.
      await updateState(async ({ options, state: value }) => {
        const current = cacheState(value);
        const attempt = entryFor(current.attempts, source.key);
        if (!ownsAttempt(current, source, token) || attempt.finishedAt !== undefined) return;
        return storedState({ ...current, attempts: withEntry(current.attempts, source.key,
          { ...attempt, finishedAt: now() }) }, await sourceKeys(options));
      }).catch(reportError);
    } finally {
      await control(() => { if (active?.token === token) active = null; });
      // A configuration or row change during the pull may require an immediate
      // replacement, and another source may be due. A successful or failed
      // current pull remains due in 30 min.
      void reconcile();
    }
  }

  function refreshDue(attempt, source) {
    if (attempt?.sourceKey !== source.key) return 0;
    if (attempt.finishedAt === undefined && attempt.startedAt !== ownStarted.get(source.key)) return 0;
    return attempt.startedAt + ANKI_INDEX_REFRESH_MS;
  }

  async function startDueRefresh() {
    await hydrate;
    if (suspended) {
      await schedule(null);
      return null;
    }
    const sources = [...(await ankiIndexSources(await readOptions())).values()];
    if (!sources.length) {
      await schedule(null);
      return null;
    }
    if (active) return { promise: active.promise };
    const state = cacheState(await readState());
    const dueAt = source => refreshDue(entryFor(state.attempts, source.key), source);
    const source = sources.find(candidate => dueAt(candidate) <= now());
    if (!source) {
      await schedule(Math.min(...sources.map(dueAt)));
      return null;
    }

    const token = { startedAt: now() };
    let reserved = false;
    await updateState(async ({ options, state: value }) => {
      const current = cacheState(value);
      const keys = await sourceKeys(options);
      if (!keys.includes(source.key)) return;
      if (refreshDue(entryFor(current.attempts, source.key), source) > now()) return;
      reserved = true;
      token.rowRevision = current.rowRevision;
      return storedState({ ...current, attempts: withEntry(current.attempts, source.key,
        { sourceKey: source.key, startedAt: token.startedAt }) }, keys);
    });
    if (!reserved) return null;
    ownStarted.set(source.key, token.startedAt);
    // Another source due sooner is started when this pull ends.
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

  // The cached rows of a Template's source, if the index holds them.
  const rowsOf = source => (source === null ? undefined : snapshots.get(source.key));

  async function local(config, expression) {
    const [source, wordKey] = await Promise.all([ankiIndexSource(config), Promise.resolve(ankiWordKey(expression))]);
    if (source === null || wordKey === null) {
      return { source, wordKey, mature: false, noteIds: [], cached: false };
    }
    await hydrate;
    const cached = rowsOf(source)?.get(wordKey);
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

  // A popup's entries for one Template: snapshot hits answer locally, and the
  // misses share one live lookup, one per word key. Found rows are recorded as
  // `find` records them; a true miss still leaves no negative row.
  async function findMany(config, expressions, invoke) {
    const found = await Promise.all(expressions.map(expression => local(config, expression)));
    const misses = new Map();
    found.forEach(({ source, wordKey, cached }, index) => {
      if (source !== null && wordKey !== null && !cached && !misses.has(wordKey)) misses.set(wordKey, expressions[index]);
    });
    const live = new Map();
    if (misses.size) {
      const [{ source }] = found;
      const values = await lookupLiveMany(source, [...misses.values()], invoke);
      if (!Array.isArray(values) || values.length !== misses.size) {
        throw new Error("Anki returned an invalid duplicate lookup result.");
      }
      [...misses.keys()].forEach((wordKey, position) => live.set(wordKey, normalizedLookup(values[position], wordKey)));
      // The control queue still writes the rows one at a time, in this order.
      await Promise.all([...live].filter(([, value]) => value.noteIds.length).map(([wordKey, value]) =>
        updateRow(source, wordKey, () => ({ mature: value.mature, noteIds: value.noteIds }))));
    }
    return found.map(({ wordKey, mature, noteIds, cached }) => {
      const value = live.get(wordKey);
      return value ? { ...value, noteIds: [...value.noteIds], cached: false } : { wordKey, mature, noteIds, cached };
    });
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
    lookupMany: findMany,
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
      return rowsOf(source)?.get(wordKey)?.mature === true;
    },
    // A page's headwords, keyed only by the cached rows of the requested
    // profile's first Template and answered from memory like `has`, with the
    // row revision every snapshot shares. A source with no cached snapshot is
    // unavailable (null), not a page of unknown words.
    async statuses(config, headwords) {
      const source = await ankiIndexSource(config);
      await hydrate;
      const rows = rowsOf(source);
      if (rows === undefined) {
        return { revision: rowRevision, statuses: null };
      }
      return {
        revision: rowRevision,
        statuses: headwords.map(headword => {
          const wordKey = ankiWordKey(headword);
          const row = wordKey === null ? null : rows.get(wordKey) ?? null;
          if (row === null) return "unknown";
          return row.mature ? "known" : "learning";
        }),
      };
    },
  };
}
