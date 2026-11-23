import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../i18n";
import { invokeIpc } from "../lib/ipc";

type Form = {
  expression: string;
  options: { id: string; sentence: string; tags: string[] | null }[];
  back: boolean;
  deleteDuplicate: boolean;
};

export function AnkiGroupingDialog() {
  const t = useTranslation();
  const [form, setForm] = useState<Form>();
  const [candidate, setCandidate] = useState(0);
  const [back, setBack] = useState(false);
  const [deleteDuplicate, setDelete] = useState(true);
  const [error, setError] = useState("");
  const pending = useRef(false);

  useEffect(() => {
    let active = true;
    invokeIpc<Form>("ankiGrouping.options").then(data => {
      if (!active) return;
      setBack(data.back);
      setDelete(data.deleteDuplicate);
      setForm(data);
    }).catch(e => { if (active) setError(String(e)); });
    return () => { active = false; };
  }, []);

  const finish = useCallback(async (action: "keep" | "merge" | "overwrite") => {
    if (pending.current) return;
    pending.current = true;
    try {
      await invokeIpc("ankiGrouping.resolve", action === "keep" ? null : {
        candidate, back, deleteDuplicate, overwrite: action === "overwrite",
      });
    } catch (e) {
      pending.current = false;
      setError(String(e));
    }
  }, [candidate, back, deleteDuplicate]);

  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); void finish("keep"); }
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [finish]);

  return <main className="scene-switcher-picker">
    <h1>{t("ankiGrouping.title")}</h1>
    {error && <p role="alert">{error}</p>}
    {form && <form className="grid gap-4" onSubmit={e => { e.preventDefault(); void finish("merge"); }}>
      <p>{t("ankiGrouping.prompt", { word: form.expression })}</p>
      <label className="grid gap-1">{t("ankiGrouping.target")}
        <select autoFocus value={candidate} onChange={e => setCandidate(Number(e.currentTarget.value))}>
          {form.options.map((note, index) => <option key={note.id} value={index}>
            {t("ankiGrouping.note", { id: note.id, sentence: note.sentence || t("ankiGrouping.noSentence") })}
            {note.tags?.length ? `  [${note.tags.join(", ")}]` : ""}
          </option>)}
        </select>
      </label>
      <label className="grid gap-1">{t("ankiGrouping.order")}
        <select value={back ? "back" : "front"} onChange={e => setBack(e.currentTarget.value === "back")}>
          <option value="front">{t("ankiGrouping.front")}</option>
          <option value="back">{t("ankiGrouping.back")}</option>
        </select>
      </label>
      <label><input type="checkbox" checked={deleteDuplicate} onChange={e => setDelete(e.currentTarget.checked)} /> {t("ankiGrouping.delete")}</label>
      <p>{t("ankiGrouping.groups")}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" onClick={() => void finish("keep")}>{t("ankiGrouping.keep")}</button>
        <button type="button" title={t("ankiGrouping.overwriteHelp")} onClick={() => void finish("overwrite")}>{t("ankiGrouping.overwrite")}</button>
        <button type="submit" className="primary">{t("ankiGrouping.merge")}</button>
      </div>
    </form>}
  </main>;
}
