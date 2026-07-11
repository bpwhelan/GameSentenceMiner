import { useCallback, useEffect, useState } from "react";
import { invokeIpc, onIpc } from "../lib/ipc";
import { useTranslation } from "../i18n";
import type { WindowSceneSwitcherConflict } from "../../../shared/window_scene_switcher";

export function SceneSwitchConflictWindow() {
  const t = useTranslation();
  const [conflict, setConflict] = useState<WindowSceneSwitcherConflict | null>(null);
  const [resolving, setResolving] = useState(false);

  const load = useCallback(async () => {
    const next = await invokeIpc<WindowSceneSwitcherConflict | null>(
      "scene-switcher.getPendingConflict"
    );
    setConflict(next);
  }, []);

  useEffect(() => {
    void load();
    return onIpc("scene-switcher.stateChanged", () => void load());
  }, [load]);

  const resolve = useCallback(async (sceneUuid: string | null) => {
    if (!conflict || resolving) return;
    setResolving(true);
    try {
      await invokeIpc("scene-switcher.resolveConflict", {
        requestId: conflict.requestId,
        sceneUuid,
      });
      window.close();
    } finally {
      setResolving(false);
    }
  }, [conflict, resolving]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        void resolve(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [resolve]);

  if (!conflict) {
    return <main className="scene-switcher-picker scene-switcher-picker--empty" />;
  }

  return (
    <main className="scene-switcher-picker">
      <h1>{t("sceneSwitcherPicker.title")}</h1>
      <p>{t("sceneSwitcherPicker.description")}</p>
      <dl className="scene-switcher-picker__window">
        <div>
          <dt>{t("sceneSwitcherPicker.windowTitle")}</dt>
          <dd>{conflict.foreground.title || t("sceneSwitcherPicker.untitled")}</dd>
        </div>
        <div>
          <dt>{t("sceneSwitcherPicker.executable")}</dt>
          <dd>{conflict.foreground.executableName || t("sceneSwitcherPicker.unavailable")}</dd>
        </div>
      </dl>
      <div className="scene-switcher-picker__choices">
        {conflict.candidates.map((candidate) => (
          <button
            type="button"
            key={candidate.sceneUuid}
            disabled={resolving}
            onClick={() => void resolve(candidate.sceneUuid)}
          >
            <span>{candidate.sceneName}</span>
            <small>{candidate.titlePattern}</small>
          </button>
        ))}
      </div>
      <div className="scene-switcher-picker__footer">
        <button type="button" className="secondary" disabled={resolving} onClick={() => void resolve(null)}>
          {t("sceneSwitcherPicker.cancel")}
        </button>
      </div>
    </main>
  );
}
