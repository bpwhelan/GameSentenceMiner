import { useCallback, useEffect, useRef, useState } from "react";
import { useLocale, useTranslation } from "../../i18n";
import { onIpc } from "../../lib/ipc";
import { useBufferedState } from "../../lib/useBufferedState";
import { DEBUG_TEXT_HISTORY_LIMIT as HISTORY_LIMIT } from "../../lib/debugHistory";
import { OCRLineMenu } from "./OCRLineMenu";

const SOURCE_KEYS = new Map([
  ["ocr", "ocr.activity.sources.auto"],
  ["ocr_manual", "ocr.activity.sources.manual"],
  ["secondary", "ocr.activity.sources.menu"],
  ["screen_cropper", "ocr.activity.sources.area"]
]);

interface OCRTextFeedProps {
  active?: boolean;
  running: boolean;
  paused: boolean;
  manual: boolean;
}

interface Capture {
  id: number;
  deliveryId?: string;
  text: string;
  time: number;
  source: string;
  game: string;
  excluded: boolean;
}

type Activity =
  | "captured"
  | "noText"
  | "unchanged"
  | "menu"
  | "ignored"
  | "duplicate"
  | "excluded"
  | "error";

function isRecognitionLog(payload: unknown): boolean {
  return typeof payload === "string" && /OCR Run [12](?:\s*\(bypassed\))?: Text recognized|\d+ text boxes recognized in [\d.]+s using/i.test(payload);
}

function activityFromLog(payload: unknown): Activity | null {
  if (typeof payload !== "string") return null;
  const line = payload.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  // Recognition logs include provisional text. Only the result event belongs
  // in the history; never interpret recognized text as an activity message.
  if (isRecognitionLog(line)) return null;
  if (line.includes("Text is identified as all menu items, skipping further processing.")) return "menu";
  if (line.includes("Text is inside a black hole OCR box, skipping further processing.")) return "ignored";
  if (line.includes("Seems like Text we already sent")) return "duplicate";
  if (line.includes("Image is empty (all pixels same)") || line.includes("Screen Capture Didn't get Capturing anything")) return "noText";
  if (/No text detected, sleeping\.$/i.test(line)) return "noText";
  if (/sleeping\.$/i.test(line)) return "unchanged";
  return null;
}

export function OCRTextFeed({ active = true, running, paused, manual }: OCRTextFeedProps) {
  const t = useTranslation();
  const [locale] = useLocale();
  const [captures, setCaptures] = useBufferedState<Capture[]>([], active);
  const [activity, setActivity] = useBufferedState<Activity | null>(null, active);
  const [starting, setStarting] = useBufferedState(false, active);
  const nextId = useRef(0);
  const [lineMenu, setLineMenu] = useState<{ capture: Capture; anchor: HTMLButtonElement } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const closeMenu = useCallback(() => setLineMenu(null), []);
  const timeLocale = locale === "ukr" ? "uk" : locale;

  useEffect(() => { if (!active) setLineMenu(null); }, [active]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), 4000);
    return () => clearTimeout(timer);
  }, [notice]);

  useEffect(() => {
    const offResult = onIpc("ocr-ipc-message", (_event, payload) => {
      if (
        !payload || typeof payload !== "object" ||
        !("event" in payload) || payload.event !== "ocr_result"
      ) return;
      const data = "data" in payload ? payload.data : null;
      if (
        !data || typeof data !== "object" || !("text" in data) ||
        typeof data.text !== "string" || !data.text.trim()
      ) return;
      const text = data.text;
      const timestamp = "time" in data && typeof data.time === "string"
        ? Date.parse(data.time) : NaN;
      const deliveryId = "observationId" in data && typeof data.observationId === "string"
        ? data.observationId : undefined;
      const capture: Capture = {
        id: ++nextId.current,
        deliveryId,
        text,
        game: "exclusion_game" in data && typeof data.exclusion_game === "string" ? data.exclusion_game
          : "ocr_scene" in data && typeof data.ocr_scene === "string" && data.ocr_scene ? data.ocr_scene
          : "process_path" in data && typeof data.process_path === "string" ? data.process_path : "",
        excluded: "excluded" in data && data.excluded === true,
        time: Number.isFinite(timestamp) ? timestamp : Date.now(),
        source: "source" in data && typeof data.source === "string" ? data.source : ""
      };
      setStarting(false);
      setCaptures((current) => {
        if (deliveryId && current.some((item) => item.deliveryId === deliveryId)) return current;
        return [capture, ...current].slice(0, HISTORY_LIMIT);
      });
      setActivity(capture.excluded ? "excluded" : "captured");
    });
    const offLog = onIpc("ocr-log", (_event, payload) => {
      const next = activityFromLog(payload);
      if (!next && !isRecognitionLog(payload)) return;
      setActivity(current => {
        const blocked = current === "menu" || current === "ignored" || current === "excluded";
        // Area filters also produce an empty result and a generic idle log.
        // Keep their reason until recognition proceeds or the frame is blank.
        const blankFrame = typeof payload === "string" && /Image is empty \(all pixels same\)|Screen Capture Didn't get Capturing anything/.test(payload);
        if (isRecognitionLog(payload) && blocked) return null;
        if (blocked && !blankFrame && (next === "unchanged" || next === "noText")) return current;
        return next ?? current;
      });
    });
    const offStarted = onIpc("ocr-started", () => {
      setActivity(null);
      setStarting(true);
    });
    const offReady = onIpc("ocr-ipc-started", () => setStarting(false));
    const offStatus = onIpc("ocr-ipc-status", () => setStarting(false));
    const offUnpaused = onIpc("ocr-ipc-unpaused", () => setActivity(null));
    const offError = onIpc("ocr-ipc-error", () => {
      setStarting(false);
      setActivity("error");
    });
    return () => {
      offResult();
      offLog();
      offStarted();
      offReady();
      offStatus();
      offUnpaused();
      offError();
    };
  }, []);

  const state = !running ? "stopped"
    : paused ? "paused"
    : starting ? "starting"
    : activity === "ignored" ? "blackHole"
    : activity === "menu" ? "menu"
    : activity === "excluded" ? "excluded"
    : manual ? "manual"
    : "watching";

  return (
    <section className="desk-text-feed" aria-labelledby="ocr-text-title">
      <div className="desk-section-heading">
        <div>
          <h2 id="ocr-text-title">{t("ocr.activity.title")}</h2>
          <span className="desk-muted">{t("ocr.activity.recent", { count: HISTORY_LIMIT })}</span>
        </div>
        <button
          type="button"
          className="desk-text-clear"
          aria-label={t("ocr.activity.clear")}
          disabled={!captures.length}
          onClick={() => {
            setCaptures([]);
            setActivity(null);
            setLineMenu(null);
          }}
        >
          {t("ocr.activity.clearButton")}
        </button>
      </div>
      {notice && <p className="desk-exclusion-notice" role="status">{notice}</p>}
      <div className="desk-text-panel">
        <div
          className={`desk-text-status is-${state}${activity === "error" ? " has-error" : ""}`}
          role="status"
        >
          <i aria-hidden="true" />
          <div>
            <strong>{t("ocr.activity.states." + state)}</strong>
            {running && !paused && activity ? <span>{t("ocr.activity.events." + activity)}</span> : null}
          </div>
        </div>
        <div
          className="desk-text-history"
          role="log"
          aria-label={t("ocr.activity.title")}
          aria-live="polite"
          aria-relevant="additions"
          tabIndex={0}
        >
          {captures.length ? captures.map((capture) => (
            <article className="desk-text-entry" key={capture.id}>
              <div className="desk-text-meta">
                <time
                  dateTime={new Date(capture.time).toISOString()}
                  title={new Date(capture.time).toLocaleString(timeLocale)}
                >
                  {new Date(capture.time).toLocaleTimeString(timeLocale, {
                    hour: "2-digit", minute: "2-digit", second: "2-digit"
                  })}
                </time>
                <span>{t(SOURCE_KEYS.get(capture.source) ?? "ocr.activity.sources.capture")}</span>
                {capture.excluded && <span>{t("sentenceExclusions.excluded")}</span>}
                <div className="desk-text-line-actions">
                <button
                  type="button"
                  aria-label={t("ocr.activity.copy")}
                  title={t("ocr.activity.copy")}
                  onClick={() => window.clipboard.writeText(capture.text)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="8" y="8" width="12" height="13" rx="2" />
                    <path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h3" />
                  </svg>
                </button>
                <button type="button" aria-label={t("sentenceExclusions.lineActions")}
                  title={t("sentenceExclusions.lineActions")} aria-haspopup="menu"
                  aria-expanded={lineMenu?.capture.id === capture.id}
                  aria-controls={lineMenu?.capture.id === capture.id ? "ocr-line-menu" : undefined}
                  onClick={event => setLineMenu(lineMenu?.capture.id === capture.id ? null : { capture, anchor: event.currentTarget })}>
                  <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></svg>
                </button>
                </div>
              </div>
              <div className="desk-text-content" dir="auto">{capture.text}</div>
            </article>
          )) : (
            <div className="desk-text-empty">
              <svg viewBox="0 0 24 24" aria-hidden="true">
                <path d="M5 4h14v12H9l-4 4V4Z M9 8h6 M9 12h4" />
              </svg>
              <strong>{t("ocr.activity.empty")}</strong>
              <p>{t("ocr.activity.emptyHint")}</p>
            </div>
          )}
        </div>
      </div>
      {active && lineMenu && <OCRLineMenu key={lineMenu.capture.id} anchor={lineMenu.anchor}
        text={lineMenu.capture.text} game={lineMenu.capture.game} onClose={closeMenu}
        onSaved={removed => setNotice(t(removed ? "sentenceExclusions.removed" : "sentenceExclusions.added", { game: lineMenu.capture.game }))} />}
    </section>
  );
}
