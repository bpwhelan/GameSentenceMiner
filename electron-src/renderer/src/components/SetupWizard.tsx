import { useCallback, useEffect, useState } from "react";

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
            Skip Setup
          </button>
          <div className="wizard-footer-right">
            {!isFirst && (
              <button className="wizard-btn wizard-btn-back" onClick={goBack}>
                ← Back
              </button>
            )}
            <button className="wizard-btn wizard-btn-next" onClick={goNext}>
              {isLast ? "Get Started →" : "Next →"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function WelcomeStep() {
  return (
    <>
      <h2 className="wizard-title">Welcome to GameSentenceMiner! 🎮</h2>
      <p className="wizard-text">
        GSM helps you automatically create Anki flashcards from games you play.
        It captures text, audio, and screenshots to build high-quality cards for
        Language learning.
      </p>
      <div className="wizard-info-box">
        <h3>What you'll need:</h3>
        <ul>
          <li>
            <strong>Anki</strong> with the{" "}
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
              AnkiConnect
            </a>{" "}
            add-on installed and running
          </li>
          <li>
            <strong>A text source</strong> — Agent, Textractor, or built-in OCR
          </li>
          <li>
            <strong>OBS Studio</strong> (optional) — for audio/video recording
          </li>
        </ul>
      </div>
      <p className="wizard-text-muted">
        This wizard will walk you through the basics. You can always change
        settings later.
      </p>
    </>
  );
}

function InputSourceStep() {
  return (
    <>
      <h2 className="wizard-title">Text Input Sources 📝</h2>
      <p className="wizard-text">
        GSM needs a way to read text from your game. Here are the most common
        options:
      </p>
      <div className="wizard-options">
        <div className="wizard-option">
          <h3>🔌 Agent (Recommended)</h3>
          <p>
            Works with most Visual Novels. Connects automatically via websocket
            on port 9001.
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
            Get Agent →
          </a>
        </div>
        <div className="wizard-option">
          <h3>👁️ Built-in OCR</h3>
          <p>
            Use screen OCR for games where text hooking doesn't work. Configure
            in the OCR tab after setup.
          </p>
        </div>
        <div className="wizard-option">
          <h3>📋 Clipboard</h3>
          <p>
            If your text source copies to clipboard, GSM can read from there
            automatically.
          </p>
        </div>
      </div>
      <p className="wizard-text-muted">
        Websocket sources (Agent, Textractor, LunaTranslator) can be managed in
        Settings → General.
      </p>
    </>
  );
}

function AnkiStep({ connectivity }: { connectivity: ConnectivityStatus }) {
  const statusIcon = (status: "checking" | "connected" | "failed") => {
    if (status === "checking") return "⏳";
    if (status === "connected") return "✅";
    return "❌";
  };

  return (
    <>
      <h2 className="wizard-title">Connectivity Check 🔗</h2>
      <p className="wizard-text">
        Let's verify your external tools are reachable:
      </p>
      <div className="wizard-connectivity">
        <div
          className={`wizard-conn-item ${connectivity.anki}`}
        >
          <span className="wizard-conn-icon">
            {statusIcon(connectivity.anki)}
          </span>
          <div>
            <strong>Anki (AnkiConnect)</strong>
            <p>
              {connectivity.anki === "checking" && "Checking connection..."}
              {connectivity.anki === "connected" &&
                "Connected! AnkiConnect is running."}
              {connectivity.anki === "failed" && (
                <>
                  Not reachable. Make sure Anki is open with the{" "}
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
                    AnkiConnect add-on
                  </a>{" "}
                  installed.
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
            <strong>OBS Studio (WebSocket)</strong>
            <p>
              {connectivity.obs === "checking" && "Checking connection..."}
              {connectivity.obs === "connected" &&
                "Connected! OBS WebSocket server is running."}
              {connectivity.obs === "failed" &&
                "Not reachable. OBS is optional — you can set it up later in Settings."}
            </p>
          </div>
        </div>
      </div>
      <p className="wizard-text-muted">
        You can continue even if connections fail — configure them later in
        Settings.
      </p>
    </>
  );
}

function FinishStep() {
  return (
    <>
      <h2 className="wizard-title">You're All Set! 🎉</h2>
      <p className="wizard-text">
        GSM is ready to go. Here are some tips to get started:
      </p>
      <div className="wizard-info-box">
        <ul>
          <li>
            Open the <strong>Home</strong> tab to see the current game text stream
          </li>
          <li>
            Use <strong>Game Settings</strong> to configure per-game profiles
          </li>
          <li>
            Check the <strong>Settings</strong> tab for Anki, audio, and hotkey
            configuration
          </li>
          <li>
            The <strong>Console</strong> tab shows what GSM is doing behind the
            scenes
          </li>
        </ul>
      </div>
      <p className="wizard-text">
        For detailed guides and troubleshooting, visit the{" "}
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
          GSM Wiki
        </a>
        {" "}or join the{" "}
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
          Discord community
        </a>
        .
      </p>
    </>
  );
}
