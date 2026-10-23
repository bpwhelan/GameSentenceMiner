import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../../i18n";
import { invokeIpc } from "../../lib/ipc";
import type { ObsCaptureMode, ObsScene } from "../../types/models";

interface HomeGameMenuProps {
  scene: ObsScene;
  anchor: HTMLButtonElement;
  current: boolean;
  onClose: () => void;
  onRename: (scene: ObsScene) => void;
  onRemove: (scene: ObsScene) => Promise<void>;
  onSwitchCaptureMode: (scene: ObsScene, mode: ObsCaptureMode) => Promise<void>;
  onCaptureWizard: () => void;
}

export function HomeGameMenu({ scene, anchor, current, onClose, onRename, onRemove, onSwitchCaptureMode, onCaptureWizard }: HomeGameMenuProps) {
  const t = useTranslation();
  const menuRef = useRef<HTMLDivElement>(null);
  const mountedRef = useRef(false);
  const workingRef = useRef(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [mode, setMode] = useState<ObsCaptureMode | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void invokeIpc<ObsCaptureMode | null>("obs.getSceneCaptureMode", scene.id)
      .then(value => { if (!cancelled) setMode(value === "window_capture" || value === "game_capture" ? value : null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [scene.id]);

  useLayoutEffect(() => {
    const menu = menuRef.current!;
    const target = anchor.getBoundingClientRect();
    const bounds = menu.getBoundingClientRect();
    const margin = 8;
    setPosition({
      left: Math.max(margin, Math.min(target.right + margin, window.innerWidth - bounds.width - margin)),
      top: Math.max(margin, Math.min(target.top, window.innerHeight - bounds.height - margin)),
    });
  }, [anchor, mode, current, failed]);

  useEffect(() => {
    mountedRef.current = true;
    menuRef.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !anchor.contains(event.target)) onClose();
    };
    const moved = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      mountedRef.current = false;
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
  }, [anchor, onClose]);

  const dismiss = () => {
    if (anchor.isConnected) anchor.focus();
    onClose();
  };
  const perform = async (action: () => Promise<void>) => {
    if (workingRef.current) return;
    workingRef.current = true;
    setBusy(true);
    setFailed(false);
    try { await action(); if (mountedRef.current) dismiss(); }
    catch { if (mountedRef.current) setFailed(true); }
    finally { workingRef.current = false; if (mountedRef.current) setBusy(false); }
  };

  return createPortal(
    <div ref={menuRef} id="home-game-menu" className="home-game-menu" role="menu"
      aria-label={t("home.workspace.gameActions", { name: scene.name })} aria-busy={busy} style={position}
      onKeyDown={(event) => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
        else if (event.key === "Tab") dismiss();
        else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
          if (!items.length) return;
          const index = items.findIndex(item => item === document.activeElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next].focus();
        }
      }}>
      <div className="home-game-menu__title">{scene.name}</div>
      <button type="button" role="menuitem" disabled={busy} onClick={() => { dismiss(); onRename(scene); }}>{t("home.obs.rename")}</button>
      {current && <button type="button" role="menuitem" disabled={busy} onClick={() => { dismiss(); onCaptureWizard(); }}>{t("home.obs.runCaptureWizard")}</button>}
      {mode && <button type="button" role="menuitem" disabled={busy} onClick={() => void perform(() => onSwitchCaptureMode(scene, mode))}>
        {t(mode === "window_capture" ? "home.obs.switchToGameCapture" : "home.obs.switchToWindowCapture")}
      </button>}
      <div role="separator" className="home-game-menu__separator" />
      <button type="button" role="menuitem" className="home-game-menu__remove" disabled={busy} onClick={() => void perform(() => onRemove(scene))}>{t("home.obs.remove")}</button>
      {failed && <p role="alert">{t("home.workspace.gameActionError")}</p>}
    </div>, document.body,
  );
}
