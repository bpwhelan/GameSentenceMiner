import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { useTranslation } from "../../i18n";
import { invokeIpc } from "../../lib/ipc";

interface PythonInfo {
  success: boolean;
  pythonVersion?: string;
  pythonPath?: string;
  pipVersion?: string;
}

export function PythonSettings({ active, onRequestConsole }: {
  active: boolean;
  onRequestConsole?: () => void;
}) {
  const t = useTranslation();
  const [info, setInfo] = useState<PythonInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [customPackage, setCustomPackage] = useState("");
  const [busy, setBusy] = useState(false);
  const changing = useRef(false);
  const infoRequest = useRef(0);
  const [status, setStatus] = useState<{ message: string; error: boolean } | null>(null);

  const loadInfo = useCallback(async () => {
    const request = ++infoRequest.current;
    setLoading(true);
    setInfoError(null);
    try {
      const result = await invokeIpc<PythonInfo>("python.getPythonInfo");
      if (request !== infoRequest.current) return;
      if (!result?.success) throw new Error(t("app.python.envInfo.error"));
      setInfo(result);
    } catch (error) {
      if (request === infoRequest.current) {
        setInfoError(t("settings.python.actionFailed", { error: error instanceof Error ? error.message : String(error) }));
      }
    } finally {
      if (request === infoRequest.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    if (active) void loadInfo();
  }, [active, loadInfo]);

  const runAction = async (action: "reset" | "install") => {
    if (changing.current) return;
    const packageName = customPackage.trim();
    if (action === "install" && !packageName) return;
    changing.current = true;
    setBusy(true);
    setStatus(null);
    try {
      if (action === "reset") {
        const confirmation = await invokeIpc<{ response: number }>("show-message-box", {
          type: "warning",
          title: t("app.python.management.resetTitle"),
          message: t("app.python.management.resetMessage"),
          detail: t("app.python.management.resetDetail"),
          buttons: [t("app.python.cancel"), t("app.python.management.resetConfirm")],
          defaultId: 0,
          cancelId: 0,
        });
        if (confirmation.response !== 1) return;
      }
      setStatus({ message: action === "reset" ? t("app.python.management.resetting")
        : t("app.python.customPackage.installing", { package: packageName }), error: false });
      onRequestConsole?.();
      const result = action === "reset"
        ? await invokeIpc<{ success: boolean; message: string }>("python.resetDependencies")
        : await invokeIpc<{ success: boolean; message: string }>("python.installCustomPackage", packageName);
      setStatus({ message: result.message, error: !result.success });
      if (result.success) {
        if (action === "install") setCustomPackage("");
        void loadInfo();
      }
    } catch (error) {
      setStatus({ message: t("settings.python.actionFailed", { error: error instanceof Error ? error.message : String(error) }), error: true });
    } finally {
      changing.current = false;
      setBusy(false);
    }
  };

  const submitPackage = (event: FormEvent) => {
    event.preventDefault();
    void runAction("install");
  };
  const value = (field: keyof Omit<PythonInfo, "success">) =>
    info?.[field] || t(loading ? "app.python.envInfo.loading" : "app.python.envInfo.unknown");

  return (
    <div className="settings-form-width python-settings">
      <p className="python-settings-intro">{t("settings.python.description")}</p>
      <section className="ws-section">
        <div className="python-settings-heading">
          <h2>{t("settings.python.environment")}</h2>
          <div className="python-settings-actions">
            <button type="button" disabled={loading || busy} onClick={() => void loadInfo()}>{t("app.python.envInfo.refresh")}</button>
            <button type="button" onClick={onRequestConsole}>{t("settings.python.openLogs")}</button>
          </div>
        </div>
        <dl className="python-settings-info" aria-busy={loading}>
          <div><dt>{t("settings.python.version")}</dt><dd><code>{value("pythonVersion")}</code></dd></div>
          <div><dt>{t("settings.python.path")}</dt><dd><code>{value("pythonPath")}</code></dd></div>
          <div><dt>{t("settings.python.pip")}</dt><dd><code>{value("pipVersion")}</code></dd></div>
        </dl>
        {infoError ? <p className="ws-notice is-error" role="alert">{infoError}</p> : null}
      </section>
      <section className="ws-section python-settings-recovery">
        <div>
          <h2>{t("settings.python.recovery")}</h2>
          <p>{t("settings.python.resetHelp")}</p>
        </div>
        <button type="button" disabled={busy} onClick={() => void runAction("reset")}>{t("app.python.management.resetDeps")}</button>
      </section>
      <details className="python-settings-custom">
        <summary>{t("app.python.customPackage.title")}</summary>
        <p>{t("settings.python.customHelp")}</p>
        <form onSubmit={submitPackage}>
          <label htmlFor="custom-package-input">{t("app.python.customPackage.label")}</label>
          <div className="python-settings-package-row">
            <input id="custom-package-input" type="text" placeholder={t("app.python.customPackage.placeholder")}
              value={customPackage} disabled={busy} onChange={event => setCustomPackage(event.target.value)} />
            <button type="submit" disabled={busy || !customPackage.trim()}>{t("app.python.customPackage.installBtn")}</button>
          </div>
        </form>
      </details>
      {status ? <p className={`ws-notice${status.error ? " is-error" : ""}`} role={status.error ? "alert" : "status"}>{status.message}</p> : null}
    </div>
  );
}
