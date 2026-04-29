import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../i18n";

interface SetupWizardProps {
  onComplete: () => void;
}

type WizardStep = "welcome" | "input-source" | "anki" | "finish";

const STEPS: WizardStep[] = ["welcome", "input-source", "anki", "finish"];

interface ConnectivityStatus {
  anki: "checking" | "connected" | "failed";
  obs: "checking" | "connected" | "failed";
}

export function SetupWizard({ onComplete }: SetupWizardProps) {
  const t = useTranslation();
  const [step, setStep] = useState<WizardStep>("welcome");
  const [connectivity, setConnectivity] = useState<ConnectivityStatus>({
    anki: "checking",
    obs: "checking"
  });

  const stepIndex = STEPS.indexOf(step);
  const isFirst = stepIndex === 0;
  const isLast = stepIndex === STEPS.length - 1;

  const goNext = useCallback(() => {
    if (isLast) {
      window.ipcRenderer.invoke("settings.saveSettings", {
        setupWizardVersion: 1,
        hasCompletedSetup: true
      });
      onComplete();
    } else {
      setStep(STEPS[stepIndex + 1]);
    }
  }, [stepIndex, isLast, onComplete]);

  const goBack = useCallback(() => {
    if (!isFirst) {
      setStep(STEPS[stepIndex - 1]);
    }
  }, [stepIndex, isFirst]);

  const skipWizard = useCallback(() => {
    window.ipcRenderer.invoke("settings.saveSettings", {
      setupWizardVersion: 1,
      hasCompletedSetup: true
    });
    onComplete();
  }, [onComplete]);

  // Check connectivity when we hit the anki step
  useEffect(() => {
    if (step !== "anki") return;
    setConnectivity({ anki: "checking", obs: "checking" });

    // Check Anki
    fetch("http://127.0.0.1:8765", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "version", version: 6 })
    })
      .then((r) => r.json())
      .then(() => setConnectivity((prev) => ({ ...prev, anki: "connected" })))
      .catch(() => setConnectivity((prev) => ({ ...prev, anki: "failed" })));

    // Check OBS
    // OBS websocket check is tricky from renderer; just show informational status
    setConnectivity((prev) => ({ ...prev, obs: "checking" }));
    // We'll try a simple websocket probe
    try {
      const ws = new WebSocket("ws://127.0.0.1:4455");
      ws.onopen = () => {
        setConnectivity((prev) => ({ ...prev, obs: "connected" }));
        ws.close();
      };
      ws.onerror = () => {
        setConnectivity((prev) => ({ ...prev, obs: "failed" }));
      };
      // Timeout after 3s
      setTimeout(() => {
        if (ws.readyState !== WebSocket.OPEN) {
          ws.close();
          setConnectivity((prev) =>
            prev.obs === "checking" ? { ...prev, obs: "failed" } : prev
          );
        }
      }, 3000);
    } catch {
      setConnectivity((prev) => ({ ...prev, obs: "failed" }));
    }
  }, [step]);

  return (
    <div className="wizard-overlay">
      <div className="wizard-card">
        <div className="wizard-progress">
          {STEPS.map((s, i) => (
            <div
              key={s}
              className={`wizard-progress-dot ${i <= stepIndex ? "active" : ""} ${i === stepIndex ? "current" : ""}`}
            />
          ))}
        </div>

        <div className="wizard-content">
          {step === "welcome" && <WelcomeStep />}
          {step === "input-source" && <InputSourceStep />}
          {step === "anki" && <AnkiStep connectivity={connectivity} />}
          {step === "finish" && <FinishStep />}
        </div>

        <div className="wizard-footer">
          <button
            className="wizard-btn wizard-btn-skip"
            onClick={skipWizard}
          >
            {t("wizard.skip")}
          </button>
          <div className="wizard-footer-right">
            {!isFirst && (
              <button className="wizard-btn wizard-btn-back" onClick={goBack}>
                {t("wizard.back")}
              </button>
            )}
            <button className="wizard-btn wizard-btn-next" onClick={goNext}>
              {isLast ? t("wizard.getStarted") : t("wizard.next")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WelcomeStep() {
  const t = useTranslation();
  return (
    <>
      <h2 className="wizard-title">{t("wizard.welcome.title")}</h2>
      <p className="wizard-text">
        {t("wizard.welcome.description")}
      </p>
      <div className="wizard-info-box">
        <h3>{t("wizard.welcome.whatYouNeed")}</h3>
        <ul>
          <li>
            <strong>{t("wizard.welcome.ankiLabel")}</strong> {t("wizard.welcome.ankiWith")}{" "}
            <a
              href="#"
              onClick={(e) => {
                e.preventDefault();
                window.ipcRenderer.invoke(
                  "open-external",
                  "https://ankiweb.net/shared/info/2055492159"
                );
              }}
            >
              {t("wizard.welcome.ankiConnect")}
            </a>{" "}
            {t("wizard.welcome.ankiAddonRunning")}
          </li>
          <li>
            <strong>{t("wizard.welcome.textSourceLabel")}</strong> {t("wizard.welcome.textSourceDesc")}
          </li>
          <li>
            <strong>{t("wizard.welcome.obsLabel")}</strong> {t("wizard.welcome.obsDesc")}
          </li>
        </ul>
      </div>
      <p className="wizard-text-muted">
        {t("wizard.welcome.hint")}
      </p>
    </>
  );
}

function InputSourceStep() {
  const t = useTranslation();
  return (
    <>
      <h2 className="wizard-title">{t("wizard.textSources.title")}</h2>
      <p className="wizard-text">
        {t("wizard.textSources.description")}
      </p>
      <div className="wizard-options">
        <div className="wizard-option">
          <h3>{t("wizard.textSources.agentTitle")}</h3>
          <p>
            {t("wizard.textSources.agentDesc")}
          </p>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              window.ipcRenderer.invoke(
                "open-external",
                "https://github.com/0xDC00/agent"
              );
            }}
          >
            {t("wizard.textSources.agentLink")}
          </a>
        </div>
        <div className="wizard-option">
          <h3>{t("wizard.textSources.ocrTitle")}</h3>
          <p>
            {t("wizard.textSources.ocrDesc")}
          </p>
        </div>
        <div className="wizard-option">
          <h3>{t("wizard.textSources.clipboardTitle")}</h3>
          <p>
            {t("wizard.textSources.clipboardDesc")}
          </p>
        </div>
      </div>
      <p className="wizard-text-muted">
        {t("wizard.textSources.hint")}
      </p>
    </>
  );
}

function AnkiStep({ connectivity }: { connectivity: ConnectivityStatus }) {
  const t = useTranslation();
  const statusIcon = (status: "checking" | "connected" | "failed") => {
    if (status === "checking") return "⏳";
    if (status === "connected") return "✅";
    return "❌";
  };

  return (
    <>
      <h2 className="wizard-title">{t("wizard.connectivity.title")}</h2>
      <p className="wizard-text">
        {t("wizard.connectivity.description")}
      </p>
      <div className="wizard-connectivity">
        <div
          className={`wizard-conn-item ${connectivity.anki}`}
        >
          <span className="wizard-conn-icon">
            {statusIcon(connectivity.anki)}
          </span>
          <div>
            <strong>{t("wizard.connectivity.ankiLabel")}</strong>
            <p>
              {connectivity.anki === "checking" && t("wizard.connectivity.checking")}
              {connectivity.anki === "connected" &&
                t("wizard.connectivity.ankiConnected")}
              {connectivity.anki === "failed" && (
                <>
                  {t("wizard.connectivity.ankiFailedPre")}{" "}
                  <a
                    href="#"
                    onClick={(e) => {
                      e.preventDefault();
                      window.ipcRenderer.invoke(
                        "open-external",
                        "https://ankiweb.net/shared/info/2055492159"
                      );
                    }}
                  >
                    {t("wizard.connectivity.ankiConnectAddon")}
                  </a>{" "}
                  {t("wizard.connectivity.ankiFailedPost")}
                </>
              )}
            </p>
          </div>
        </div>
        <div
          className={`wizard-conn-item ${connectivity.obs}`}
        >
          <span className="wizard-conn-icon">
            {statusIcon(connectivity.obs)}
          </span>
          <div>
            <strong>{t("wizard.connectivity.obsLabel")}</strong>
            <p>
              {connectivity.obs === "checking" && t("wizard.connectivity.checking")}
              {connectivity.obs === "connected" &&
                t("wizard.connectivity.obsConnected")}
              {connectivity.obs === "failed" &&
                t("wizard.connectivity.obsFailed")}
            </p>
          </div>
        </div>
      </div>
      <p className="wizard-text-muted">
        {t("wizard.connectivity.hint")}
      </p>
    </>
  );
}

function FinishStep() {
  const t = useTranslation();
  return (
    <>
      <h2 className="wizard-title">{t("wizard.finish.title")}</h2>
      <p className="wizard-text">
        {t("wizard.finish.description")}
      </p>
      <div className="wizard-info-box">
        <ul>
          <li dangerouslySetInnerHTML={{ __html: t("wizard.finish.tipHome") }} />
          <li dangerouslySetInnerHTML={{ __html: t("wizard.finish.tipGameSettings") }} />
          <li dangerouslySetInnerHTML={{ __html: t("wizard.finish.tipSettings") }} />
          <li dangerouslySetInnerHTML={{ __html: t("wizard.finish.tipConsole") }} />
        </ul>
      </div>
      <p className="wizard-text">
        {t("wizard.finish.guidePre")}{" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            window.ipcRenderer.invoke(
              "open-external",
              "https://github.com/bpwhelan/GameSentenceMiner/wiki"
            );
          }}
        >
          {t("wizard.finish.guideWikiLink")}
        </a>
        {" "}{t("wizard.finish.guideOr")}{" "}
        <a
          href="#"
          onClick={(e) => {
            e.preventDefault();
            window.ipcRenderer.invoke(
              "open-external",
              "https://discord.gg/yP8Qse6bb8"
            );
          }}
        >
          {t("wizard.finish.guideDiscordLink")}
        </a>
        .
      </p>
    </>
  );
}
