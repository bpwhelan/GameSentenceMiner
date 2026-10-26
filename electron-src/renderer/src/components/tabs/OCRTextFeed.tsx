import { useEffect, useRef } from "react";
import { useLocale, useTranslation } from "../../i18n";
import { onIpc } from "../../lib/ipc";
import { useBufferedState } from "../../lib/useBufferedState";
import { DEBUG_TEXT_HISTORY_LIMIT as HISTORY_LIMIT } from "../../lib/debugHistory";

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
}

type Activity =
  | "captured"
  | "noText"
  | "unchanged"
  | "menu"
  | "ignored"
  | "duplicate"
  | "error";

function activityFromLog(payload: unknown): Activity | null {
  if (typeof payload !== "string") return null;
  const line = payload.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  // Recognition logs include provisional text. Only the result event belongs
  // in the history; never interpret recognized text as an activity message.
  if (/OCR Run [12](?:\s*\(bypassed\))?: Text recognized/i.test(line)) return null;
  if (line.includes("Text is identified as all menu items, skipping further processing.")) return "menu";
  if (line.includes("Text is inside a black hole OCR box, skipping further processing.")) return "ignored";
  if (line.includes("Seems like Text we already sent")) return "duplicate";
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
  const timeLocale = locale === "ukr" ? "uk" : locale;

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
        time: Number.isFinite(timestamp) ? timestamp : Date.now(),
        source: "source" in data && typeof data.source === "string" ? data.source : ""
      };
      setStarting(false);
      setCaptures((current) => {
        if (deliveryId && current.some((item) => item.deliveryId === deliveryId)) return current;
        return [capture, ...current].slice(0, HISTORY_LIMIT);
      });
      setActivity("captured");
    });
    const offLog = onIpc("ocr-log", (_event, payload) => {
      const next = activityFromLog(payload);
      if (next) setActivity(next);
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
          }}
        >
          {t("ocr.activity.clearButton")}
        </button>
      </div>
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
    </section>
  );
}
