import { useEffect, useRef, useState } from "react";
import { useTranslation } from "../../i18n";
import { invokeIpc, onIpc } from "../../lib/ipc";
import type { ObsScene } from "../../types/models";
import { excludedSentences, type SentenceExclusionsSnapshot } from "../../../../shared/sentence_exclusions";

export function SentenceExclusions({ active }: { active: boolean }) {
  const t = useTranslation();
  const [games, setGames] = useState<Record<string, string[]>>({});
  const [sceneNames, setSceneNames] = useState<string[]>([]);
  const [game, setGame] = useState("");
  const [text, setText] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setLoaded(false);
    setFailed(false);
    void Promise.all([
      invokeIpc<SentenceExclusionsSnapshot>("textprocess.exclusions.list"),
      invokeIpc<ObsScene[]>("obs.getScenes"),
      invokeIpc<ObsScene | null>("obs.getActiveScene")
    ]).then(([snapshot, scenes, current]) => {
      if (cancelled) return;
      if (!snapshot.success || !snapshot.games) throw new Error("load failed");
      const names = Array.isArray(scenes) ? scenes.map(scene => scene.name).filter(Boolean) : [];
      if (current?.name && !names.includes(current.name)) names.push(current.name);
      setSceneNames(names);
      setGames(snapshot.games);
      setGame(current?.name || names[0] || Object.keys(snapshot.games)[0] || "");
      setLoaded(true);
    }).catch(() => { if (!cancelled) setFailed(true); });
    const off = onIpc("textprocess-exclusions-changed", (_event, value) => {
      const snapshot = value as SentenceExclusionsSnapshot;
      if (snapshot?.success && snapshot.games) setGames(snapshot.games);
    });
    return () => { cancelled = true; off(); };
  }, [active]);

  const change = async (sentence: string, action: "add" | "remove") => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const snapshot = await invokeIpc<SentenceExclusionsSnapshot>(`textprocess.exclusions.${action}`, { game, text: sentence });
      if (!snapshot.success || !snapshot.games) throw new Error("save failed");
      setGames(snapshot.games);
      if (action === "add") setText("");
    } catch { setFailed(true); }
    finally { working.current = false; setBusy(false); }
  };

  const names = [...new Set([...sceneNames, ...Object.keys(games)])];
  const sentences = excludedSentences(games, game);
  return (
    <section className="sentence-exclusions" aria-labelledby="sentence-exclusions-title">
      <div className="text-processing-section-heading">
        <h2 id="sentence-exclusions-title">{t("sentenceExclusions.title")}</h2>
        <span className="ws-state">{t("sentenceExclusions.perGame")}</span>
      </div>
      <p className="text-processing-hint">{t("sentenceExclusions.description")}</p>
      {failed && <p role="alert">{t("sentenceExclusions.failed")}</p>}
      {!loaded ? (!failed && <p>{t("textProcessing.loading")}</p>) : <>
        <label htmlFor="sentence-exclusions-game">{t("sentenceExclusions.game")}</label>
        <select id="sentence-exclusions-game" value={game} disabled={busy || !names.length}
          onChange={event => { setGame(event.target.value); setText(""); setFailed(false); }}>
          {!names.length && <option value="">{t("sentenceExclusions.noGame")}</option>}
          {names.map(name => <option key={name} value={name}>{name}</option>)}
        </select>
        {game && <>
          <form onSubmit={event => { event.preventDefault(); void change(text, "add"); }}>
            <label htmlFor="sentence-exclusions-text">{t("sentenceExclusions.sentence")}</label>
            <textarea id="sentence-exclusions-text" rows={2} value={text} disabled={busy}
              placeholder={t("sentenceExclusions.placeholder")} onChange={event => setText(event.target.value)} />
            <button type="submit" className="btn-secondary" disabled={busy || !text.trim()}>{t("sentenceExclusions.add")}</button>
          </form>
          {sentences.length ? <ul className="sentence-exclusions-list">
            {sentences.map(sentence => <li key={sentence}>
              <span dir="auto">{sentence}</span>
              <button type="button" className="btn-secondary" disabled={busy}
                aria-label={t("sentenceExclusions.removeSentence", { sentence })}
                onClick={() => void change(sentence, "remove")}>{t("sentenceExclusions.remove")}</button>
            </li>)}
          </ul> : <p className="text-processing-hint">{t("sentenceExclusions.empty")}</p>}
        </>}
      </>}
    </section>
  );
}
