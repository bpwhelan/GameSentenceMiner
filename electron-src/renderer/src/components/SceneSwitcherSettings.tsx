import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invokeIpc, onIpc } from "../lib/ipc";
import { useTranslation } from "../i18n";
import type { ObsScene } from "../types/models";
import type { WindowSceneSwitcherState } from "../../../shared/window_scene_switcher";

interface SceneSwitcherSettingsProps {
  scene: ObsScene;
}

interface SaveRuleResponse {
  success: boolean;
  error?: string;
}

function getPatternError(pattern: string): string | null {
  if (!pattern.trim()) return null;
  try {
    new RegExp(pattern, "i");
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export function SceneSwitcherSettings({ scene }: SceneSwitcherSettingsProps) {
  const t = useTranslation();
  const [state, setState] = useState<WindowSceneSwitcherState | null>(null);
  const [titlePattern, setTitlePattern] = useState("");
  const [ruleEnabled, setRuleEnabled] = useState(false);
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);
  const dirtyRef = useRef(false);

  const load = useCallback(async (preserveDraft = false) => {
    const next = await invokeIpc<WindowSceneSwitcherState>(
      "scene-switcher.getState",
      scene.id
    );
    setState(next);
    if (!preserveDraft || !dirtyRef.current) {
      setTitlePattern(next.rule?.titlePattern ?? "");
      setRuleEnabled(next.rule?.enabled ?? false);
      dirtyRef.current = false;
    }
  }, [scene.id]);

  useEffect(() => {
    dirtyRef.current = false;
    void load().catch(() => setMessage(t("sceneSwitcher.status.loadFailed")));
    return onIpc("scene-switcher.stateChanged", () => {
      void load(true).catch(() => setMessage(t("sceneSwitcher.status.loadFailed")));
    });
  }, [load, t]);

  const patternError = useMemo(() => getPatternError(titlePattern), [titlePattern]);
  const hasValidPattern = Boolean(titlePattern.trim()) && !patternError;

  const save = useCallback(async (enabled: boolean) => {
    if (!hasValidPattern || saving) return false;
    setSaving(true);
    try {
      const result = await invokeIpc<SaveRuleResponse>("scene-switcher.saveRule", {
        sceneUuid: scene.id,
        sceneName: scene.name,
        titlePattern,
        enabled,
      });
      if (!result.success) {
        setMessage(result.error ?? t("sceneSwitcher.status.saveFailed"));
        return false;
      }
      if (enabled && !state?.collectionEnabled) {
        await invokeIpc("scene-switcher.setCollectionEnabled", true);
      }
      dirtyRef.current = false;
      setMessage("");
      await load();
      return true;
    } catch {
      setMessage(t("sceneSwitcher.status.saveFailed"));
      return false;
    } finally {
      setSaving(false);
    }
  }, [hasValidPattern, load, saving, scene.id, scene.name, state?.collectionEnabled, t, titlePattern]);

  const savePattern = useCallback(async () => {
    if (!dirtyRef.current || patternError) return;
    if (!titlePattern.trim()) {
      setSaving(true);
      try {
        await invokeIpc("scene-switcher.removeRule", scene.id);
        dirtyRef.current = false;
        setRuleEnabled(false);
        setMessage("");
        await load();
      } catch {
        setMessage(t("sceneSwitcher.status.saveFailed"));
      } finally {
        setSaving(false);
      }
      return;
    }
    await save(ruleEnabled);
  }, [load, patternError, ruleEnabled, save, scene.id, t, titlePattern]);

  const toggleRule = useCallback(async (enabled: boolean) => {
    const previous = ruleEnabled;
    setRuleEnabled(enabled);
    if (!(await save(enabled))) {
      setRuleEnabled(previous);
    }
  }, [ruleEnabled, save]);

  if (window.gsmEnv?.platform !== "win32") {
    return null;
  }

  return (
    <section className="scene-switcher-settings" aria-label={t("sceneSwitcher.title")}>
      <h3>{t("sceneSwitcher.title")}</h3>

      <label className="scene-switcher-settings__toggle" htmlFor={`scene-switcher-rule-${scene.id}`}>
        <input
          id={`scene-switcher-rule-${scene.id}`}
          type="checkbox"
          checked={ruleEnabled}
          disabled={!hasValidPattern || saving || state?.migrationReady === false}
          onChange={(event) => void toggleRule(event.target.checked)}
        />
        <span>{t("sceneSwitcher.ruleEnabled")}</span>
      </label>

      <div className="scene-switcher-settings__field">
        <label htmlFor={`scene-switcher-pattern-${scene.id}`}>
          {t("sceneSwitcher.titlePattern")}
        </label>
        <input
          id={`scene-switcher-pattern-${scene.id}`}
          type="text"
          className="scene-switcher-settings__pattern"
          value={titlePattern}
          placeholder={t("sceneSwitcher.titlePatternPlaceholder")}
          onChange={(event) => {
            dirtyRef.current = true;
            setTitlePattern(event.target.value);
          }}
          onBlur={() => void savePattern()}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          spellCheck={false}
          aria-invalid={Boolean(patternError)}
        />
        {patternError && <span className="scene-switcher-settings__error">{patternError}</span>}
      </div>

      {!state?.migrationReady && state && (
        <p className="scene-switcher-settings__warning">{t("sceneSwitcher.migrationPending")}</p>
      )}
      {state?.hookError && <p className="scene-switcher-settings__warning">{state.hookError}</p>}
      {message && <p className="scene-switcher-settings__message" aria-live="polite">{message}</p>}
    </section>
  );
}
