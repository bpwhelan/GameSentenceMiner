import { useEffect, useState } from "react";
import { useTranslation } from "../../i18n";
import { loadCapturePreviews } from "../../lib/captureTargets";
import type { ObsWindow } from "../../types/models";
import { WorkspaceIcon } from "../Workspace";

interface CaptureTargetPickerProps {
  windows: ObsWindow[];
  selectedValue: string;
  disabled: boolean;
  loading: boolean;
  supported: boolean;
  previewsEnabled: boolean;
  onSelect: (value: string) => void;
  onRefresh: () => Promise<void>;
}

export function CaptureTargetPicker({ windows, selectedValue, disabled, loading, supported,
  previewsEnabled, onSelect, onRefresh }: CaptureTargetPickerProps) {
  const t = useTranslation();
  const [search, setSearch] = useState("");
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const [previewsLoading, setPreviewsLoading] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  // Sorting or status polling must not continuously recapture every desktop window.
  const previewKey = JSON.stringify(windows.filter(w => (w.targetKind ?? "window") === "window")
    .map(w => [w.value, w.title, w.captureSource?.processPath ?? '']).sort((a, b) => a[0].localeCompare(b[0])));

  useEffect(() => {
    if (!previewsEnabled || previewKey === "[]") return;
    let cancelled = false;
    setPreviewsLoading(true);
    setPreviews({});
    void loadCapturePreviews(windows)
      .then(result => {
        if (!cancelled) setPreviews(Object.fromEntries((result ?? []).map(p => [p.value, p.imageData])));
      })
      .catch(() => { if (!cancelled) setPreviews({}); })
      .finally(() => { if (!cancelled) setPreviewsLoading(false); });
    return () => { cancelled = true; };
  }, [previewKey, previewsEnabled, refreshVersion]);

  const query = search.trim().toLocaleLowerCase();
  const filtered = windows.filter(w => `${w.title} ${w.suggestedSceneName ?? ""}`.toLocaleLowerCase().includes(query));
  const groups = [
    { key: "windows", labelKey: "home.obs.sectionWindows", options: filtered.filter(w => w.targetKind !== "monitor" && w.targetKind !== "capture_card") },
    { key: "monitors", labelKey: "home.obs.sectionMonitors", options: filtered.filter(w => w.targetKind === "monitor") },
    { key: "cards", labelKey: "home.obs.sectionCaptureCards", options: filtered.filter(w => w.targetKind === "capture_card") },
  ];
  const selected = windows.find(w => w.value === selectedValue);
  const titleFor = (w: ObsWindow) => w.targetKind === "wayland_pipewire" ? t("home.obs.waylandPipewireOption") : w.title;

  return (
    <div className="home-capture-picker">
      <div className="home-capture-picker__toolbar">
        <label className="home-capture-picker__search" htmlFor="home-window-search">
          <WorkspaceIcon name="search" />
          <input id="home-window-search" className="home-input" type="search" autoComplete="off"
            aria-label={t("home.capturePicker.search")} placeholder={t("home.capturePicker.search")}
            value={search} disabled={disabled || !supported} onChange={event => setSearch(event.target.value)} />
        </label>
        <button type="button" className="home-icon-btn" disabled={disabled || !supported || loading}
          aria-label={t("home.obs.refreshWindows")} title={t("home.obs.refreshWindows")}
          onClick={async () => { await onRefresh(); setRefreshVersion(v => v + 1); }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.74-6.26L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.74 6.26L3 16M8 16H3v5" /></svg>
        </button>
      </div>
      <div className="home-capture-picker__list" aria-label={t("home.obs.captureTargetLabel")}>
        {!supported ? <p role="status">{t("home.obs.notSupportedOS")}</p>
          : windows.length === 0 ? <p role="status">{t(loading ? "home.obs.loading" : "home.obs.noCaptureTargets")}</p>
          : filtered.length === 0 ? <p role="status">{t("home.capturePicker.noMatches")}</p>
          : groups.filter(group => group.options.length > 0).map(group => (
            <section key={group.key} aria-labelledby={`home-capture-${group.key}`}>
              <div className="home-capture-picker__heading">
                <h3 id={`home-capture-${group.key}`}>{t(group.labelKey)}</h3>
                {group.key === "windows" && windows.some(w => w.lastFocusedAt) &&
                  <span>{t("home.capturePicker.recentOrder")}</span>}
              </div>
              <div className="home-capture-picker__grid">
                {group.options.map(w => {
                  const isWindow = (w.targetKind ?? "window") === "window";
                  return (
                    <button key={w.value} type="button" className="home-capture-target"
                      data-window-value={w.value} aria-pressed={w.value === selectedValue}
                      disabled={disabled} title={titleFor(w)} onClick={() => onSelect(w.value)}>
                      <span className={`home-capture-target__preview${isWindow ? "" : " home-capture-target__preview--device"}`}>
                        {previews[w.value] ? <img src={previews[w.value]} alt="" /> : <>
                          <WorkspaceIcon name="general" />
                          {isWindow && <span>{t(previewsLoading ? "home.capturePicker.loadingPreview" : "home.capturePicker.previewUnavailable")}</span>}
                        </>}
                        {w.value === selectedValue && <span className="home-capture-target__check" aria-hidden="true">✓</span>}
                      </span>
                      <span className="home-capture-target__title">{titleFor(w)}</span>
                      {Boolean(w.lastFocusedAt) && <span className="home-capture-target__recent">{t("home.capturePicker.recent")}</span>}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
      </div>
      {selected && <p className="home-capture-picker__selection">{t("home.capturePicker.selected", { title: titleFor(selected) })}</p>}
      {previewsEnabled && <p className="home-capture-picker__hint">{t("home.capturePicker.snapshotHint")}</p>}
    </div>
  );
}
