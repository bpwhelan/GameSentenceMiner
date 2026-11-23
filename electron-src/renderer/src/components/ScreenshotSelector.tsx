import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n";
import { invokeIpc } from "../lib/ipc";
import "./ScreenshotSelector.css";

type Frame = { index: number; seconds: number; url: string };
type Page = { page: number; frames: Frame[]; reference: number; earlier: boolean; later: boolean };

export function ScreenshotSelector() {
  const t = useTranslation();
  const [page, setPage] = useState<Page>();
  const [choices, setChoices] = useState<Frame[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const revision = useRef(0);
  const selected = useRef<Frame[]>([]);
  const saveInProgress = useRef(false);

  const load = useCallback(async (number: number) => {
    if (saveInProgress.current) return;
    const request = ++revision.current;
    setLoading(true);
    setError("");
    try {
      const result = await invokeIpc<Page>("screenshotSelector.page", {
        page: number, selected: selected.current.map(f => f.index), revision: request,
      });
      if (revision.current === request) setPage(result);
    } catch (e) {
      if (revision.current === request) setError(String(e));
    } finally {
      if (revision.current === request) setLoading(false);
    }
  }, []);
  useEffect(() => { void load(0); return () => { ++revision.current; }; }, [load]);

  const change = (frames: Frame[]) => {
    selected.current = frames;
    setChoices(frames);
  };
  const save = async (frames: Frame[]) => {
    if (saveInProgress.current || !frames.length) return;
    saveInProgress.current = true;
    setSaving(true);
    setError("");
    try {
      await invokeIpc("screenshotSelector.save", { selected: frames.map(f => f.index) });
    } catch (e) {
      saveInProgress.current = false;
      setSaving(false);
      setError(String(e));
    }
  };
  const cancel = useCallback(() => { void invokeIpc("screenshotSelector.cancel"); }, []);
  useEffect(() => {
    const keydown = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); cancel(); }
      if (!page || loading || saving) return;
      if (e.key === "ArrowLeft" && page.earlier) { e.preventDefault(); void load(page.page - 1); }
      if (e.key === "ArrowRight" && page.later) { e.preventDefault(); void load(page.page + 1); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [page, loading, saving, load, cancel]);

  const pick = (frame: Frame, collect: boolean) => {
    if (!collect && !choices.length) { void save([frame]); return; }
    change(choices.some(f => f.index === frame.index)
      ? choices.filter(f => f.index !== frame.index) : [...choices, frame]);
  };
  const move = (i: number, delta: number) => {
    const next = [...choices];
    [next[i], next[i + delta]] = [next[i + delta], next[i]];
    change(next);
  };
  const relative = (frame: Frame) => {
    const diff = frame.seconds - (page?.reference ?? 0);
    return t("screenshotSelector.seconds", { value: (diff >= 0 ? "+" : "") + diff.toFixed(3) });
  };
  const busy = loading || saving;
  return <main className="screenshot-selector">
    <header><h1>{t("screenshotSelector.title")}</h1><p>{t("screenshotSelector.hint")}</p></header>
    <nav>
      <button disabled={busy || !page?.earlier} onClick={() => page && void load(page.page - 1)}>{t("screenshotSelector.earlier")}</button>
      {page && <span>{t("screenshotSelector.range", { first: relative(page.frames[0]), last: relative(page.frames[page.frames.length-1]) })}</span>}
      <button disabled={busy || page?.page === 0} onClick={() => void load(0)}>{t("screenshotSelector.reset")}</button>
      <button disabled={busy || !page?.later} onClick={() => page && void load(page.page + 1)}>{t("screenshotSelector.later")}</button>
    </nav>
    {error && <p role="alert">{t("screenshotSelector.error", { message: error })}</p>}
    {busy && <p role="status">{t(saving ? "screenshotSelector.saving" : "screenshotSelector.loading")}</p>}
    <section className="screenshot-frames" aria-busy={busy}>
      {page?.frames.map(frame => {
        const order = choices.findIndex(f => f.index === frame.index);
        return <button key={frame.index} disabled={busy} aria-pressed={order >= 0}
          onClick={e => pick(frame, e.ctrlKey || e.metaKey || e.shiftKey)}>
          <img src={frame.url} alt="" /><span>{order >= 0 && t("screenshotSelector.order", { number: order + 1 })}
          {frame.index === 0 ? t("screenshotSelector.defaultFrame", { time: relative(frame) }) : relative(frame)}</span>
        </button>;
      })}
    </section>
    {choices.length > 0 && <ol className="screenshot-choices">
      {choices.map((frame,i) => <li key={frame.index}>
        <img src={frame.url} alt="" /><span>{t("screenshotSelector.order", {number: i+1})}{relative(frame)}</span>
        <button disabled={busy || i===0} onClick={() => move(i,-1)} aria-label={t("screenshotSelector.moveEarlier")}>←</button>
        <button disabled={busy || i+1===choices.length} onClick={() => move(i,1)} aria-label={t("screenshotSelector.moveLater")}>→</button>
        <button disabled={busy} onClick={() => change(choices.filter(f => f.index !== frame.index))} aria-label={t("screenshotSelector.remove")}>×</button>
      </li>)}
    </ol>}
    <footer>
      {!!choices.length && <button disabled={busy} onClick={() => change([])}>{t("screenshotSelector.clear")}</button>}
      <button onClick={cancel}>{t("screenshotSelector.cancel")}</button>
      {!!choices.length && <button disabled={busy} onClick={() => void save(choices)}>{t("screenshotSelector.use", { count: choices.length })}</button>}
    </footer>
  </main>;
}
