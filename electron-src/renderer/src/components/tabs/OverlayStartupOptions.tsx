import { useEffect, useState } from "react";
import { useTranslation } from "../../i18n";
import { invokeIpc } from "../../lib/ipc";
import type { AppSettings } from "../../types/models";
import "./OverlayStartupOptions.css";

type OverlayOptions = Pick<AppSettings, "runOverlayOnStartup" | "runOverlayWithActiveGame">;

// A tab opened during a save should read the committed preferences.
let pendingSave: Promise<{ success: boolean; settings?: Partial<OverlayOptions> }> | undefined;

export function useOverlayStartupOptions(active: boolean) {
  const [options, setOptions] = useState<OverlayOptions | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    setOptions(null);
    setError(false);
    async function load() {
      try {
        if (pendingSave) await pendingSave.catch(() => {});
        const saved = await invokeIpc<Partial<OverlayOptions>>("settings.getSettings");
        if (!cancelled) setOptions({
          runOverlayOnStartup: saved.runOverlayOnStartup === true,
          runOverlayWithActiveGame: saved.runOverlayWithActiveGame === true,
        });
      } catch {
        if (!cancelled) setError(true);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [active]);

  async function change(key: keyof OverlayOptions, enabled: boolean) {
    if (!options || pendingSave) return;
    const other = key === "runOverlayOnStartup" ? "runOverlayWithActiveGame" : "runOverlayOnStartup";
    const patch = { [key]: enabled, ...(enabled ? { [other]: false } : {}) };
    setSaving(true);
    setError(false);
    try {
      pendingSave = invokeIpc("settings.saveSettings", patch);
      const result = await pendingSave;
      if (!result?.success) throw new Error("Overlay preferences could not be saved");
      setOptions({ ...options, ...patch, ...result.settings });
    } catch {
      setError(true);
    } finally {
      pendingSave = undefined;
      setSaving(false);
    }
  }

  return { options, saving, error, change };
}

export function OverlayStartupOptions({ state, prefix }: {
  state: ReturnType<typeof useOverlayStartupOptions>;
  prefix: string;
}) {
  const t = useTranslation();
  const { options, saving, error, change } = state;
  return (
    <div className="overlay-startup-options">
      <label data-tip={t("home.overlay.runOnStartupTooltip")}>
        <input type="checkbox" id={prefix + "-overlay-startup-toggle"}
          checked={options?.runOverlayOnStartup ?? false} disabled={!options || saving}
          onChange={event => void change("runOverlayOnStartup", event.target.checked)} />
        {t("home.overlay.runOnStartup")}
      </label>
      <label data-tip={t("home.overlay.runWithActiveGameTooltip")}>
        <input type="checkbox" id={prefix + "-overlay-active-game-toggle"}
          checked={options?.runOverlayWithActiveGame ?? false} disabled={!options || saving}
          onChange={event => void change("runOverlayWithActiveGame", event.target.checked)} />
        {t("home.overlay.runWithActiveGame")}
      </label>
      {error && <p role="alert">{t("home.overlay.settingsError")}</p>}
    </div>
  );
}
