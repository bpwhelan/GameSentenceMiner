import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useLocale, useTranslation } from "../i18n";
import { invokeIpc, onIpc } from "../lib/ipc";
import { audioFilters, keepRanges, ReviewWaveform, useReviewAudio } from "./cardReviewAudio";
import type { AudioFilter, AudioForm, Range } from "./cardReviewAudio";
import "./CardReviewWindow.css";

type Dialogue = { id: number; previous: string | null; next: string | null; lines: string[]; visible: boolean };
type Picture = { id: number; url: string };
type Form = {
  expression: string;
  expressionLabel: string;
  sentence: string | null;
  translation: string | null;
  picture: string;
  previousPicture: string;
  animated: boolean;
  animatedAvif: boolean;
  reusedPicture: boolean;
  overlayOnly: boolean;
  canScreenshot: boolean;
  canTranslate: boolean;
  canTts: boolean;
  audio: AudioForm;
  dialogue: Dialogue;
  preferences: { autoplay: boolean; timer: number; step: number; gamepad: Record<string, unknown> | null };
};
type Draft = {
  sentence: string;
  translation: string;
  picture: Picture;
  previousPicture: Picture;
  audio: AudioForm;
  dialogue: Dialogue;
  range: Range;
  cuts: Range[];
  filter: AudioFilter;
  filterUrl?: string;
  nsfw: boolean;
  refreshTranslation: boolean;
};
type Document = { form: Form; past: Draft[]; draft: Draft; future: Draft[] };
type Entry = { id: string; expression: string; sentence: string; scene: string; created: string };
type Queue = { entries: Entry[]; autoAdvance: boolean };
type Prompt = "discard" | "delete" | "later" | "keepAudio" | "skipAudio";
type Result = "saved" | "kept" | "deleted" | "missing";

function call<T>(action: string, payload: object = {}): Promise<T> {
  return invokeIpc<T>(`cardDialog.${action}`, payload);
}

function initial(form: Form): Document {
  return { form, past: [], future: [], draft: {
    sentence: form.sentence ?? "", translation: form.translation ?? "",
    picture: { id: 0, url: form.picture }, previousPicture: { id: 0, url: form.previousPicture },
    audio: form.audio, dialogue: form.dialogue, ...audioSelection(form.audio), filter: "none",
    nsfw: false, refreshTranslation: true,
  } };
}

function audioSelection(audio: AudioForm): Pick<Draft, "range" | "cuts"> {
  return { range: audio.initialRange ?? [0, audio.duration], cuts: audio.initialCuts ?? [] };
}

function editPayload(draft: Draft, voice: boolean) {
  return {
    sentence: draft.sentence, translation: draft.translation, nsfw: draft.nsfw,
    voice, audio: draft.audio.id, start: draft.range[0], end: draft.range[1], cuts: draft.cuts, filter: draft.filter,
    picture: draft.picture.id, previousPicture: draft.previousPicture.id, dialogue: draft.dialogue.id,
  };
}

function isEdited(document: Document) {
  const baseline = initial(document.form).draft;
  return JSON.stringify(editPayload(document.draft, false)) !== JSON.stringify(editPayload(baseline, false));
}

function ReviewPrompt({ kind, onCancel, onConfirm, onDelete }: {
  kind: Prompt; onCancel: () => void; onConfirm: () => void; onDelete: () => void;
}) {
  const t = useTranslation();
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return <dialog className="cr-modal" data-audio-prompt={kind === "keepAudio" || kind === "skipAudio" ? "" : undefined}
    ref={ref} onCancel={e => { e.preventDefault(); onCancel(); }}>
    <h2>{t(`cardReview.prompt.${kind}.title`)}</h2>
    <p>{t(`cardReview.prompt.${kind}.body`)}</p>
    <footer>
      <button type="button" className={kind === "delete" ? "cr-danger" : ""} onClick={onConfirm}>
        {t(kind === "discard" ? "cardReview.ok" : "cardReview.yes")}
      </button>
      {kind === "discard" && <button type="button" className="cr-danger" onClick={onDelete}>{t("cardReview.discardDelete")}</button>}
      <button type="button" autoFocus onClick={onCancel}>{t("cardReview.cancel")}</button>
    </footer>
  </dialog>;
}

type EditorProps = {
  entry: string;
  review: boolean;
  quietSelection: boolean;
  document: Document;
  update: (entry: string, apply: (document: Document) => Document) => void;
  onSave: (voice: boolean) => void;
  onError: (error: unknown) => void;
  cancelTimer: () => void;
  countdown: ReactNode;
  promptOpen: boolean;
  onGamepadConfirm: (voice: boolean) => void;
  onBusy: (busy: boolean) => void;
};

function Editor({ entry, review, quietSelection, document, update, onSave, onError, onBusy, cancelTimer, countdown, promptOpen, onGamepadConfirm }: EditorProps) {
  const t = useTranslation();
  const { form, draft } = document;
  const { audio, dialogue, range, cuts, filter, filterUrl } = draft;
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const [autoplay, setAutoplay] = useState(form.preferences.autoplay);
  const [changedAutoplay, setChangedAutoplay] = useState(false);
  const [disabledSession, setDisabledSession] = useState(false);
  const [cutMode, setCutMode] = useState(false);
  const [expanded, setExpanded] = useState("");
  const [hoverPreview, setHoverPreview] = useState<{ url: string; left: number; top: number; width: number }>();
  const trimTimer = useRef(0);
  const player = useReviewAudio(filterUrl ?? audio.url, range, cuts, autoplay && (!quietSelection || changedAutoplay));
  const step = form.preferences.step;
  const panel = useRef<HTMLElement>(null);
  const refreshError = useRef(false);
  useEffect(() => () => window.clearTimeout(trimTimer.current), [audio.id]);

  const change = useCallback((patch: Partial<Draft>, grouped = false) => {
    cancelTimer();
    update(entry, current => {
      const past = grouped && current.past.length ? current.past : [...current.past.slice(-99), current.draft];
      return { ...current, draft: { ...current.draft, ...patch }, past, future: [] };
    });
  }, [cancelTimer, entry, update]);

  // Treat a continuous typing session as one undoable edit.
  const typing = useRef<"sentence" | "translation" | null>(null);
  const editText = (field: "sentence" | "translation", value: string) => {
    change({ [field]: value }, typing.current === field);
    typing.current = field;
  };

  const work = async (perform: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    cancelTimer();
    window.clearTimeout(trimTimer.current);
    player.stop(true);
    setBusy(true);
    onBusy(true);
    try { await perform(); }
    catch (error) { onError(error); }
    finally {
      pending.current = false;
      setBusy(false);
      onBusy(false);
    }
  };
  useEffect(() => {
    if (!dialogue.visible) return;
    let alive = true;
    const refresh = async () => {
      if (pending.current || refreshError.current) return;
      try {
        const context = await call<Dialogue>("context", { entry, dialogue: dialogue.id });
        if (alive && (context.previous !== dialogue.previous || context.next !== dialogue.next)) {
          update(entry, current => current.draft.dialogue.id === context.id
            ? { ...current, draft: { ...current.draft, dialogue: context } } : current);
        }
      } catch { if (alive) refreshError.current = true; }
    };
    const timer = window.setInterval(() => { void refresh(); }, 1400);
    return () => { alive = false; window.clearInterval(timer); };
  }, [dialogue, entry, update]);

  const selectPicture = (previous: boolean) => work(async () => {
    const picture = await call<Picture | null>("picture", { entry, previous, dialogue: dialogue.id });
    if (picture) change(previous ? { previousPicture: picture } : { picture });
  });
  const filterPreview = (clip: AudioForm, preset: AudioFilter) => clip.url && preset !== "none"
    ? call<string>("audioFilter", { entry, audio: clip.id, filter: preset })
    : undefined;
  const changeFilter = (preset: AudioFilter) => work(async () => {
    change({ filter: preset, filterUrl: await filterPreview(audio, preset) });
  });
  const changeDialogue = (next: boolean) => work(async () => {
    const option = next ? dialogue.next : dialogue.previous;
    if (!option) return;
    const values = await call<Pick<Draft, "sentence" | "translation" | "audio" | "dialogue">>("dialogue", {
      entry, next, audio: audio.id, dialogue: dialogue.id,
      translation: draft.translation, refreshTranslation: draft.refreshTranslation,
    });
    if (values.audio.id === audio.id) {
      change(values);
    } else {
      change({ ...values, ...audioSelection(values.audio), filterUrl: await filterPreview(values.audio, filter) });
      setCutMode(false);
    }
  });
  const expand = (left: boolean) => {
    if (left ? !audio.canExpandStart : !audio.canExpandEnd) return;
    return work(async () => {
      const next = await call<{ audio: AudioForm; selection: Range; shift: number; scale: number }>("expand", {
        entry, left, audio: audio.id, start: range[0], end: range[1],
      });
      const shift = (t: number) => Math.min(next.audio.duration, Math.max(0, t * next.scale + next.shift));
      change({ audio: next.audio, range: next.selection,
        cuts: cuts.map(([a, b]): Range => [shift(a), shift(b)]).filter(([a, b]) => b > a),
        filterUrl: await filterPreview(next.audio, filter) });
    });
  };
  const tts = () => work(async () => {
    const next = await call<AudioForm>("tts", { entry, sentence: draft.sentence });
    change({ audio: next, ...audioSelection(next), filterUrl: await filterPreview(next, filter) });
    setCutMode(false);
  });
  const play = () => { window.clearTimeout(trimTimer.current); cancelTimer(); player.toggle(); };
  const editRange = (next: Range) => {
    if (next[0] === range[0] && next[1] === range[1]) return;
    if (next[0] !== range[0]) {
      player.stop();
      player.seek(next[0]);
      window.clearTimeout(trimTimer.current);
      trimTimer.current = window.setTimeout(() => player.playFrom(next[0], next), 500);
    } else { player.limitEnd(next[1]); }
    change({ range: next });
  };
  const addCut = (rangeToCut: Range) => {
    window.clearTimeout(trimTimer.current);
    player.stop();
    change({ cuts: [...cuts, rangeToCut] });
    setCutMode(false);
  };
  const editCut = (index: number, cut: Range | null) => {
    if (cut && cut[0] === cuts[index][0] && cut[1] === cuts[index][1]) return;
    window.clearTimeout(trimTimer.current);
    player.stop();
    change({ cuts: cut ? cuts.map((previous, i) => i === index ? cut : previous) : cuts.filter((_, i) => i !== index) });
  };
  const save = (voice: boolean) => { window.clearTimeout(trimTimer.current); player.stop(true); onSave(voice); };

  useEffect(() => {
    function keys(event: KeyboardEvent) {
      if (pending.current || promptOpen || event.isComposing || !(event.ctrlKey || event.metaKey)) return;
      const key = event.key.toLowerCase();
      if (key !== "z" && key !== "y") return;
      event.preventDefault();
      cancelTimer();
      window.clearTimeout(trimTimer.current);
      typing.current = null;
      player.stop(true);
      const undo = key === "z" && !event.shiftKey;
      update(entry, current => {
        if (undo && current.past.length) return {
          ...current, draft: current.past[current.past.length - 1], past: current.past.slice(0, -1), future: [current.draft, ...current.future],
        };
        if (!undo && current.future.length) return {
          ...current, draft: current.future[0], past: [...current.past, current.draft], future: current.future.slice(1),
        };
        return current;
      });
    }
    window.addEventListener("keydown", keys);
    return () => window.removeEventListener("keydown", keys);
  }, [cancelTimer, entry, player.stop, promptOpen, update]);

  const [focused, setFocused] = useState(() => window.document.hasFocus());
  useEffect(() => {
    if (!review) return;
    const onFocus = () => setFocused(true);
    const onBlur = () => setFocused(false);
    window.addEventListener("focus", onFocus);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("blur", onBlur);
    };
  }, [review]);
  useReviewGamepad(!review || focused ? form.preferences.gamepad : null, panel, promptOpen || busy || !!expanded, {
    play_audio: play,
    confirm_with_audio: () => onGamepadConfirm(true),
    confirm_without_audio: () => onGamepadConfirm(false),
    add_previous_line: () => void changeDialogue(false),
    add_next_line: () => void changeDialogue(true),
    expand_audio_start: () => void expand(true),
    expand_audio_end: () => void expand(false),
  });

  const status = audio.reused ? "audioReused" : audio.fallback ? "timingWarning" :
    player.failed || (audio.available && !audio.url) ? "audioUnavailable" : !audio.available ? "noAudio" :
      audio.tts ? "ttsReady" : audio.voice ? "voiceDetected" : audio.vadRan ? "noVoiceDetected" : "audioAvailable";
  const screenshot = (previous: boolean, selection: Picture) => {
    const reused = !previous && form.reusedPicture && selection.id === 0;
    const animated = !previous && form.animated && selection.id === 0;
    return <section className="cr-panel cr-picture">
      <div className="cr-row">
        <span>{t(previous ? "cardReview.previousScreenshot" : "cardReview.screenshot")}</span>
        <button type="button" disabled={!form.canScreenshot} onClick={() => void selectPicture(previous)}>
          {t(reused ? "cardReview.changeReused" : animated ? "cardReview.replaceAnimation" : "cardReview.changeScreenshot")}
        </button>
      </div>
      {selection.url ? <button type="button" className="cr-image" onClick={() => setExpanded(selection.url)}
        onPointerEnter={e => {
          if (e.pointerType !== "mouse") return;
          const rect = e.currentTarget.getBoundingClientRect();
          const width = Math.min(560, Math.max(0, rect.left - 20));
          if (width > 220) setHoverPreview({
            url: selection.url, width, left: rect.left - width - 12, top: Math.min(rect.top, window.innerHeight - width * 9 / 16 - 10),
          });
        }}
        onPointerLeave={() => setHoverPreview(undefined)}
        aria-label={t("cardReview.previewScreenshot")}>
        <img src={selection.url} alt="" />
      </button> : <div className="cr-image cr-no-image">{t(reused ? "cardReview.screenshotReused" : "cardReview.noScreenshot")}</div>}
    </section>;
  };
  return <section className="cr-editor" ref={panel} aria-busy={busy}>
    {form.overlayOnly && <div className="cr-warning">{t("cardReview.overlayWarning")}</div>}
    <header className="cr-expression">
      <div><small>{form.expressionLabel || t("cardReview.expression")}</small><h2>{form.expression}</h2></div>
      {countdown && <strong>{countdown}</strong>}
    </header>
    <fieldset disabled={busy}>
      <div className="cr-split">
        <section className="cr-panel cr-fields">
          <label>{t("cardReview.sentence")}
            <textarea rows={2} value={draft.sentence} onChange={e => editText("sentence", e.target.value)} onBlur={() => { typing.current = null; }} />
          </label>
          {(draft.translation || form.canTranslate) && <label>{t("cardReview.translation")}
            <textarea rows={2} value={draft.translation} onChange={e => editText("translation", e.target.value)} onBlur={() => { typing.current = null; }} />
          </label>}
          {dialogue.visible && <>
            <div className="cr-context-title">{t("cardReview.context")}
              <span>{t(dialogue.lines.length === 1 ? "cardReview.oneLine" : "cardReview.linesSelected", { count: dialogue.lines.length })}</span>
            </div>
            <div className="cr-timeline">
              <div><span>● {t("cardReview.previous")}</span> {dialogue.previous ?? t("cardReview.startOfDialogue")}</div>
              {dialogue.lines.map((line, i) => <div key={i}><strong>● {t("cardReview.mined")}</strong> {line}</div>)}
              <div><span>● {t("cardReview.next")}</span> {dialogue.next ?? t("cardReview.endOfDialogue")}</div>
            </div>
            <div className="cr-tools">
              <button type="button" disabled={!dialogue.previous} onClick={() => void changeDialogue(false)}>{t("cardReview.addPrevious")}</button>
              <button type="button" disabled={!dialogue.next} onClick={() => void changeDialogue(true)}>{t("cardReview.addNext")}</button>
              {(form.canTranslate || !!draft.translation) && <label><input type="checkbox" checked={draft.refreshTranslation}
                onChange={e => change({ refreshTranslation: e.currentTarget.checked })} />{t("cardReview.refreshTranslation")}</label>}
            </div>
          </>}
        </section>
        <div className="cr-pictures">
          {screenshot(false, draft.picture)}
          {!!draft.previousPicture.url && screenshot(true, draft.previousPicture)}
        </div>
      </div>
      {form.animatedAvif && draft.picture.id === 0 && <p className="cr-warning">{t("cardReview.animatedWarning")}</p>}
      <section className="cr-panel cr-audio">
        <div className="cr-audio-status">{t("cardReview.audio")}
          <span className={`cr-status-${status}`}>{t(`cardReview.${status}`)}</span>
        </div>
        {audio.url && !player.failed && <>
          <ReviewWaveform key={audio.id} audio={audio} range={range} cuts={cuts} path={player.path} cursor={player.cursor}
            cutMode={cutMode} step={step} onRange={editRange} onCut={addCut} onEditCut={editCut}
            onInteract={cancelTimer} onSeek={player.seek} onExpand={left => void expand(left)} />
          {!keepRanges(range, cuts).length && <div className="cr-warning">{t("cardReview.emptyAudioSelection")}</div>}
        </>}
        <div className="cr-tools cr-audio-tools">
          {audio.url && !player.failed && <>
            <button type="button" className="cr-play" onClick={play} disabled={!player.path}>
              {t(player.playing ? "cardReview.pause" : "cardReview.play")}
            </button>
            <button type="button" aria-pressed={cutMode} onClick={() => { cancelTimer(); setCutMode(!cutMode); }}>{t("cardReview.cut")}</button>
            <button type="button" onClick={() => {
              window.clearTimeout(trimTimer.current);
              player.stop(true);
              change({ ...audioSelection(audio), filter: "none", filterUrl: undefined });
              setCutMode(false);
            }}>{t("cardReview.resetAudio")}</button>
          </>}
          {audio.url && <label className="cr-audio-filter">
            {t("cardReview.audioFilter")}
            <select aria-label={t("cardReview.audioFilter")} value={filter}
              onChange={event => void changeFilter(event.target.value as AudioFilter)}>
              {audioFilters.map(({ value, labelKey }) => <option key={value} value={value}>{t(labelKey)}</option>)}
            </select>
          </label>}
          {form.canTts && !audio.reused && !!draft.sentence.trim() && <button className="cr-tts" type="button" onClick={() => void tts()}>
            {t(audio.tts ? "cardReview.regenerateTts" : "cardReview.generateTts")}
          </button>}
        </div>
      </section>
    </fieldset>
    {hoverPreview && !expanded && <div className="cr-hover-picture"
      style={{ top: Math.max(8, hoverPreview.top), left: hoverPreview.left, width: hoverPreview.width }} aria-hidden="true">
      <img src={hoverPreview.url} alt="" />
    </div>}
    <fieldset className="cr-editor-footer" disabled={busy}>
      <div className="cr-tools">
        <label><input type="checkbox" checked={draft.nsfw} onChange={e => change({ nsfw: e.currentTarget.checked })}/>{t("cardReview.nsfw")}</label>
        <label><input type="checkbox" checked={autoplay} onChange={e => {
          const enabled = e.currentTarget.checked;
          setChangedAutoplay(true); setAutoplay(enabled); cancelTimer();
          void call("autoplay", { enabled }).catch(onError);
        }}/>{t("cardReview.autoplay")}</label>
        {!review && <label><input type="checkbox" checked={disabledSession} onChange={e => {
          const enabled = e.currentTarget.checked;
          setDisabledSession(enabled); cancelTimer();
          void call("disableSession", { enabled }).catch(onError);
        }}/>{t("cardReview.disableSession")}</label>}
      </div>
      <div className="cr-actions">
        <button type="button" className={audio.available ? "" : "cr-primary"} onClick={() => save(false)}>
          {t(audio.available ? review ? "cardReview.saveWithout" : "cardReview.withoutAudio" : review ? "cardReview.save" : "cardReview.confirm")}
        </button>
        {audio.available && <button type="button" className="cr-primary" disabled={!!audio.url && !keepRanges(range, cuts).length} onClick={() => save(true)}>
          {t(review ? "cardReview.saveWith" : "cardReview.keepAudio")}
        </button>}
      </div>
    </fieldset>
    {expanded && <dialog className="cr-full-picture" ref={node => { if (node && !node.open) node.showModal(); }}
      onClick={() => setExpanded("")} onCancel={() => setExpanded("")}>
      <img src={expanded} alt={t("cardReview.screenshot")}/>
    </dialog>}
  </section>;
}

const gamepadDefaults: Record<string, number> = {
  focus_up:12, focus_down:13, focus_left:14, focus_right:15, activate:0, play_audio:3,
  confirm_with_audio:2, confirm_without_audio:1, add_previous_line:6, add_next_line:7,
  expand_audio_start:4, expand_audio_end:5,
};

function useReviewGamepad(
  settings: Form["preferences"]["gamepad"], panel: React.RefObject<HTMLElement | null>,
  blocked: boolean, actions: Record<string, () => void>,
) {
  const latest = useRef({ blocked, actions });
  latest.current = { blocked, actions };
  useEffect(() => {
    if (!settings) return;
    const buttonNames = ["A", "B", "X", "Y", "LB", "RB", "LT", "RT", "BACK", "START", "LS", "RS",
      "DPADUP", "DPADDOWN", "DPADLEFT", "DPADRIGHT", "GUIDE"];
    const aliases: Record<string, number> = { SELECT: 8, "BACK/SELECT": 8, HOME: 16, MODE: 16 };
    const bindings = Object.entries(gamepadDefaults).map(([key, fallback]) => {
      const value = String(settings[`confirmation_gamepad_${key}`] ?? fallback).trim();
      const codes = value.split("+").map(part => {
        const token = part.trim().replace(/[\s_]/g, "").toUpperCase();
        return /^\d+$/.test(token) ? Number(token) : aliases[token] ?? buttonNames.indexOf(token.replace(/-/g, ""));
      });
      return [key, [...new Set(codes)]] as const;
    }).filter(([, buttons]) => buttons.every(button => Number.isInteger(button) && button >= 0 && button <= 16))
      .sort((a, b) => b[1].length - a[1].length);
    const pressed = new Map<string, Set<number>>();
    let socket: WebSocket | undefined;
    let owned = false;
    let done = false;
    let retry = 0;
    function invoke(key: string) {
      if (latest.current.blocked) {
        const confirmation = window.document.querySelector(".cr-modal[open][data-audio-prompt]");
        if (key === "activate") confirmation?.querySelector<HTMLButtonElement>("button")?.click();
        if (key === "confirm_without_audio") confirmation?.querySelector<HTMLButtonElement>("button:last-child")?.click();
        return;
      }
      if (key === "activate") {
        const active = window.document.activeElement as HTMLElement | null;
        if (panel.current?.contains(active)) active?.click();
      } else if (key.startsWith("focus_")) {
        const points = Array.from(panel.current?.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled)") ?? [])
          .filter(node => node.getClientRects().length > 0);
        const active = window.document.activeElement as HTMLElement | null;
        const at = active ? points.indexOf(active) : -1;
        const direction = key === "focus_up" || key === "focus_left" ? -1 : 1;
        const target = at < 0 ? 0 : (at + direction + points.length) % points.length;
        points[target]?.focus();
      } else {
        latest.current.actions[key]?.();
      }
    }
    const reconnect = () => { if (!done) retry = window.setTimeout(() => void connect(), 1000); };
    async function connect() {
      try {
        const url = await call<string | null>("inputService");
        if (done) return;
        if (!url) { reconnect(); return; }
        socket = new WebSocket(url);
        socket.onopen = () => {
          socket?.send(JSON.stringify({ type: "configure_gamepad_capture", enabled: true }));
          socket?.send(JSON.stringify({ type: "get_state" }));
        };
        socket.onmessage = (event: MessageEvent<string>) => {
          const message = JSON.parse(event.data);
          if (message.type === "gamepad_capture_changed") {
            owned = message.active === true && message.owned === true;
            pressed.clear();
            return;
          }
          if (!owned || !message.device) return;
          const id = String(message.device);
          if (message.type === "gamepad_disconnected") pressed.delete(id);
          if (message.type === "gamepad_state" || message.type === "gamepad_connected") {
            const state = message.type === "gamepad_state" ? message : message.state;
            pressed.set(id, new Set(Object.entries(state?.buttons ?? {})
              .filter(([, down]) => down === true).map(([index]) => Number(index))));
          }
          if (message.type !== "button") return;
          const prior = pressed.get(id) ?? new Set<number>();
          const next = new Set(prior);
          const button = Number(message.button);
          if (message.pressed === true) next.add(button); else next.delete(button);
          pressed.set(id, next);
          const action = bindings.find(([, buttons]) => buttons.every(code => next.has(code)) && !buttons.every(code => prior.has(code)));
          if (action) invoke(action[0]);
        };
        socket.onclose = () => { owned = false; pressed.clear(); reconnect(); };
      } catch { reconnect(); }
    }
    if (bindings.length) void connect();
    return () => {
      done = true;
      window.clearTimeout(retry);
      socket?.close();
    };
  }, [panel, settings]);
}

export function CardReviewWindow() {
  const t = useTranslation();
  const [locale] = useLocale();
  const [review] = useState(() => new URLSearchParams(window.location.search).get("window") === "session-review");
  const [backgroundLaunch] = useState(() => review && new URLSearchParams(window.location.search).get("live") === "1");
  const live = useRef(backgroundLaunch);
  const [quietSelection, setQuietSelection] = useState(backgroundLaunch);
  const [docs, setDocs] = useState<Record<string, Document>>({});
  const [queue, setQueue] = useState<Queue>({ entries: [], autoAdvance: true });
  const [current, setCurrent] = useState<string | null>(review ? null : "");
  const [filter, setFilter] = useState("");
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const [editorBusy, setEditorBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [saving, setSaving] = useState<string[]>([]);
  const [failed, setFailed] = useState<string[]>([]);
  const [prompt, setPrompt] = useState<Prompt>();
  const [remaining, setRemaining] = useState<number>();
  const [timerCancelled, setTimerCancelled] = useState(false);
  const [sidebar, setSidebar] = useState(255);
  const saveGuard = useRef(new Set<string>());
  const listRequest = useRef(0);
  const latestQueue = useRef({ request: 0, queue });
  const last = useRef<string | null>(null);
  const inWindow = useRef(true);
  const loaded = useRef(new Set<string>());
  const showError = useCallback((reason: unknown) => setError(String(reason)), []);
  const cancelTimer = useCallback(() => setTimerCancelled(true), []);
  const document = current !== null ? docs[current] : undefined;
  const match = filter.toLocaleLowerCase().trim();
  const visible = queue.entries.filter(entry => `${entry.expression} ${entry.sentence}`.toLocaleLowerCase().includes(match));
  const selected = queue.entries.find(entry => entry.id === current);
  const title = t(review ? "cardReview.reviewTitle" : "cardReview.confirmTitle");

  const update = useCallback((entry: string, apply: (doc: Document) => Document) => {
    setDocs(docs => docs[entry] ? { ...docs, [entry]: apply(docs[entry]) } : docs);
  }, []);
  const refresh = useCallback(async (select = false) => {
    const request = ++listRequest.current;
    const snapshot = await call<Queue>("list");
    if (!inWindow.current) return;
    if (request > latestQueue.current.request) {
      latestQueue.current = { request, queue: snapshot };
      setQueue(snapshot);
    }
    const result = latestQueue.current.queue;
    if (select) setCurrent(old => result.entries.some(entry => entry.id === old)
      ? old : (result.entries.find(entry => !saveGuard.current.has(entry.id))?.id ?? null));
    return result;
  }, []);

  useEffect(() => {
    inWindow.current = true;
    void call("ready", { title, live: backgroundLaunch }).catch(showError);
    if (review) void refresh(true).catch(showError);
    const updateQueue = () => { void refresh().catch(showError); };
    const off = review ? onIpc("cardDialog.queueChanged", () => {
      live.current = true;
      updateQueue();
    }) : undefined;
    const timer = review ? window.setInterval(updateQueue, 2000) : undefined;
    return () => { inWindow.current = false; off?.(); window.clearInterval(timer); };
  }, [backgroundLaunch, refresh, review, showError, title]);

  useEffect(() => {
    if (live.current && current === null && queue.autoAdvance && !saving.length && queue.entries.length) {
      setQuietSelection(true);
      setCurrent(queue.entries[0].id);
    }
  }, [current, queue, saving.length]);

  useEffect(() => {
    if (current === null || loaded.current.has(current)) return;
    loaded.current.add(current);
    last.current = current;
    setLoading(true);
    void call<Form>("form", { entry: current }).then(form => {
      if (inWindow.current) setDocs(state => ({ ...state, [current]: initial(form) }));
    }).catch(reason => {
      loaded.current.delete(current);
      if (inWindow.current && last.current === current) showError(reason);
    }).finally(() => {
      if (inWindow.current && last.current === current) setLoading(false);
    });
  }, [current, loadAttempt, showError]);

  const close = useCallback((removeNote = false) => {
    void call("close", { delete: removeNote }).catch(showError);
  }, [showError]);

  const requestClose = useCallback(() => {
    if (prompt) return;
    cancelTimer();
    if (busy || editorBusy || saveGuard.current.size) {
      setStatus(t("cardReview.waiting"));
      return;
    }
    if (!review) setPrompt("discard");
    else if (Object.values(docs).some(isEdited)) setPrompt("later");
    else close();
  }, [busy, cancelTimer, close, docs, editorBusy, prompt, review, t]);
  const closeRequest = useRef(requestClose);
  closeRequest.current = requestClose;
  useEffect(() => {
    const handle = () => closeRequest.current();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !window.document.querySelector("dialog[open]")) {
        event.preventDefault();
        handle();
      }
    };
    const off = onIpc("cardDialog.requestClose", handle);
    window.addEventListener("keydown", onKey);
    return () => {
      off();
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  const complete = async (id: string, action: "save" | "discard", value: object) => {
    if (saveGuard.current.has(id)) return;
    saveGuard.current.add(id);
    setError("");
    setFailed(list => list.filter(item => item !== id));
    setSaving(list => [...list, id]);
    if (review) {
      const index = visible.findIndex(entry => entry.id === id);
      const nearby = [...visible.slice(index + 1), ...visible.slice(0, index)];
      const next = nearby.find(entry => !saveGuard.current.has(entry.id))?.id ?? null;
      setQuietSelection(false);
      setCurrent(queue.autoAdvance ? next : null);
      setStatus(t("cardReview.savingBackground"));
    }
    try {
      const result = await call<Result>(action, { entry: id, ...value });
      if (review && inWindow.current) {
        loaded.current.delete(id);
        setDocs(state => Object.fromEntries(Object.entries(state).filter(([entry]) => entry !== id)));
        setQueue(state => ({ ...state, entries: state.entries.filter(entry => entry.id !== id) }));
        setStatus(t(`cardReview.result.${result}`));
        const updated = await refresh();
        if (!live.current && updated && !updated.entries.length && saveGuard.current.size === 1) close();
      }
    } catch (reason) {
      if (review) {
        setFailed(list => [...list, id]);
        setCurrent(current => current ?? id);
      }
      showError(reason);
    } finally {
      saveGuard.current.delete(id);
      setSaving(list => list.filter(item => item !== id));
    }
  };

  const performSave = (voice: boolean) => {
    cancelTimer();
    if (document && current !== null) void complete(current, "save", { edit: editPayload(document.draft, voice) });
  };
  const onAutoAccept = useRef(performSave);
  onAutoAccept.current = performSave;
  const autoSeconds = document?.form.preferences.timer ?? 0;
  const autoVoice = !!document?.form.audio.voice;
  useEffect(() => {
    if (review || !autoSeconds || timerCancelled) return;
    setRemaining(autoSeconds);
    const deadline = Date.now() + autoSeconds * 1000;
    const interval = window.setInterval(() => {
      setRemaining(Math.max(0, Math.ceil((deadline - Date.now()) / 1000)));
    }, 250);
    const timer = window.setTimeout(() => onAutoAccept.current(autoVoice), autoSeconds * 1000);
    return () => { window.clearTimeout(timer); window.clearInterval(interval); };
  }, [autoSeconds, autoVoice, review, timerCancelled]);

  const gamepadConfirm = (voice: boolean) => {
    if (!document || editorBusy || saving.length) return;
    cancelTimer();
    const { audio, range, cuts } = document.draft;
    if (voice && audio.url && !keepRanges(range, cuts).length) return;
    if (audio.available && audio.vadRan && voice !== audio.voice) setPrompt(voice ? "keepAudio" : "skipAudio");
    else performSave(voice && audio.available);
  };
  const background = async (action: () => Promise<void>) => {
    setBusy(true);
    setError("");
    try { await action(); }
    catch (reason) { showError(reason); }
    finally { setBusy(false); }
  };
  const isBlocked = busy || editorBusy || loading;
  const saveCount = saving.length;
  const canReview = !!selected && !isBlocked;
  const selectedDate = selected ? new Date(selected.created) : null;
  const dateText = selectedDate && !Number.isNaN(selectedDate.getTime())
    ? selectedDate.toLocaleString(locale === "ukr" ? "uk" : locale, { dateStyle: "short", timeStyle: "short" })
    : selected?.created;
  const editing = document && current !== null ? <Editor key={current} entry={current} review={review} quietSelection={quietSelection}
    document={document} update={update} onSave={performSave} onError={showError} cancelTimer={cancelTimer}
    countdown={autoSeconds ? t(timerCancelled ? "cardReview.autoCancelled" : "cardReview.autoAccept", { seconds: remaining ?? autoSeconds }) : null}
    promptOpen={!!prompt || saving.includes(current) || busy} onGamepadConfirm={gamepadConfirm} onBusy={setEditorBusy} /> : null;

  return <main className={`card-review${review ? " cr-session" : ""}`}>
    {review && <header className="cr-session-title">
      <h1>{t("cardReview.reviewHeading")}</h1>
      <div>{selected ? t("cardReview.reviewMeta", { scene: selected.scene, date: dateText ?? "" })
        : t(queue.entries.length ? "cardReview.chooseCard" : "cardReview.empty")}</div>
    </header>}
    {error && <div className="cr-error" role="alert">{t("cardReview.error", { error })}</div>}
    {status && <div className="cr-status" role="status">{status}</div>}
    {review ? <>
      <div className="cr-session-body" style={{ gridTemplateColumns: `${sidebar}px 7px minmax(0,1fr)` }}>
        <aside aria-label={t("cardReview.queue")}>
          <input type="search" autoFocus={!backgroundLaunch} value={filter} placeholder={t("cardReview.filter")} aria-label={t("cardReview.filter")}
            onChange={e => setFilter(e.currentTarget.value)}/>
          <div className="cr-queue">
            {visible.map(entry => <button type="button" key={entry.id} aria-current={entry.id === current}
              disabled={saving.includes(entry.id) || busy || editorBusy} title={entry.sentence}
              onClick={() => {
                last.current = entry.id;
                setQuietSelection(false);
                setError("");
                setLoading(!docs[entry.id]);
                setCurrent(entry.id);
                setLoadAttempt(old => old + 1);
              }}>
              {entry.expression}{saving.includes(entry.id) ? t("cardReview.savingSuffix") : failed.includes(entry.id) ? t("cardReview.retrySuffix") : ""}
            </button>)}
          </div>
          <div>{t("cardReview.awaiting", { count: queue.entries.filter(entry => !saving.includes(entry.id)).length })}
            {saveCount > 0 && t("cardReview.savingCount", { count: saveCount })}
            {failed.length > 0 && t("cardReview.retryCount", { count: failed.length })}
          </div>
        </aside>
        <div className="cr-resize" role="separator" aria-label={t("cardReview.resizeQueue")} aria-orientation="vertical" tabIndex={0}
          onKeyDown={e => {
            if (!["ArrowLeft", "ArrowRight"].includes(e.key)) return;
            e.preventDefault(); setSidebar(size => Math.min(400, Math.max(215, size + (e.key === "ArrowRight" ? 10 : -10))));
          }}
          onPointerDown={e => e.currentTarget.setPointerCapture(e.pointerId)}
          onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) setSidebar(Math.min(400, Math.max(215, e.clientX - 10))); }} />
        <div className="cr-session-editor" aria-busy={loading}>{editing ?? (loading ? t("cardReview.loading") : null)}</div>
      </div>
      <footer className="cr-session-footer">
        <button type="button" disabled={!canReview} onClick={() => void background(async () => {
          const result = await call<string>("openInAnki", { entry: current });
          if (result === "missing") { setStatus(t("cardReview.result.missing")); await refresh(true); }
          else setStatus(t("cardReview.opened"));
        })}>{t("cardReview.editInAnki")}</button>
        <button type="button" disabled={!canReview} onClick={() => { if (current !== null) void complete(current, "discard", { delete: false }); }}>{t("cardReview.keepCard")}</button>
        <button type="button" disabled={!canReview} onClick={() => setPrompt("delete")}>{t("cardReview.deleteCard")}</button>
        <button type="button" disabled={isBlocked} onClick={() => void background(async () => { await refresh(true); })}>{t("cardReview.refreshList")}</button>
        <button type="button" disabled={isBlocked || saveCount > 0} onClick={() => void background(async () => {
          const count = await call<number>("cleanup");
          setStatus(t("cardReview.cleanupDone", { count }));
        })}>{t("cardReview.retryCleanup")}</button>
        <button type="button" className="cr-review-later" onClick={requestClose}>{t("cardReview.reviewLater")}</button>
      </footer>
    </> : editing ?? <div role="status">{!error && t("cardReview.loading")}</div>}
    {prompt && <ReviewPrompt kind={prompt} onCancel={() => setPrompt(undefined)} onDelete={() => close(true)}
      onConfirm={() => {
        setPrompt(undefined);
        if (prompt === "delete" && current !== null) void complete(current, "discard", { delete: true });
        else if (prompt === "keepAudio" || prompt === "skipAudio") performSave(prompt === "keepAudio");
        else close();
      }} />}
  </main>;
}
