import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "../../i18n";
import { invokeIpc } from "../../lib/ipc";
import { excludedSentences, type SentenceExclusionsSnapshot } from "../../../../shared/sentence_exclusions";

export function OCRLineMenu({ anchor, text, game, onClose, onSaved }: {
  anchor: HTMLButtonElement;
  text: string;
  game: string;
  onClose: () => void;
  onSaved: (removed: boolean) => void;
}) {
  const t = useTranslation();
  const menu = useRef<HTMLDivElement>(null);
  const working = useRef(false);
  const mounted = useRef(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const [excluded, setExcluded] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    mounted.current = true;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    if (game) void invokeIpc<SentenceExclusionsSnapshot>("textprocess.exclusions.list").then(snapshot => {
      if (!mounted.current) return;
      if (!snapshot.success || !snapshot.games) throw new Error("load failed");
      setExcluded(excludedSentences(snapshot.games, game).includes(text.replace(/\r\n?/g, "\n").trim()));
      setLoaded(true);
    }).catch(() => { if (mounted.current) setFailed(true); });
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !menu.current?.contains(event.target) && !anchor.contains(event.target)) onClose();
    };
    const moved = (event: Event) => {
      if (event.target instanceof Node && menu.current?.contains(event.target)) return;
      onClose();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("scroll", moved, true);
    window.addEventListener("resize", moved);
    return () => {
      mounted.current = false;
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("scroll", moved, true);
      window.removeEventListener("resize", moved);
    };
  }, [anchor, game, text, onClose]);
  useLayoutEffect(() => {
    const target = anchor.getBoundingClientRect();
    const bounds = menu.current!.getBoundingClientRect();
    setPosition({
      left: Math.max(8, Math.min(target.right - bounds.width, window.innerWidth - bounds.width - 8)),
      top: Math.max(8, Math.min(target.bottom + 4, window.innerHeight - bounds.height - 8))
    });
  }, [anchor, failed, loaded]);
  const dismiss = () => { if (anchor.isConnected) anchor.focus(); onClose(); };
  const toggle = async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setFailed(false);
    try {
      const result = await invokeIpc<SentenceExclusionsSnapshot>(`textprocess.exclusions.${excluded ? "remove" : "add"}`, { game, text });
      if (!result.success) throw new Error("save failed");
      if (mounted.current) { onSaved(excluded); dismiss(); }
    } catch { if (mounted.current) setFailed(true); }
    finally { working.current = false; if (mounted.current) setBusy(false); }
  };
  return createPortal(
    <div id="ocr-line-menu" ref={menu} className="ocr-line-menu" role="menu" aria-busy={busy}
      aria-label={t("sentenceExclusions.lineActions")} style={position}
      onKeyDown={event => {
        if (event.key === "Escape" || event.key === "Tab") { if (event.key === "Escape") event.preventDefault(); dismiss(); }
        if (["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
          const index = items.findIndex(item => item === document.activeElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
            : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[next]?.focus();
        }
      }}>
      <div className="ocr-line-menu-game">{game ? t("sentenceExclusions.forGame", { game }) : t("sentenceExclusions.noCaptureGame")}</div>
      <button type="button" role="menuitem" onClick={() => { window.clipboard.writeText(text); dismiss(); }}>{t("ocr.activity.copy")}</button>
      <button type="button" role="menuitem" disabled={!game || !loaded || busy} onClick={() => void toggle()}>
        {t(excluded ? "sentenceExclusions.unexclude" : "sentenceExclusions.exclude")}
      </button>
      {failed && <p role="alert">{t("sentenceExclusions.failed")}</p>}
    </div>, document.body
  );
}
