import { useCallback, useEffect, useRef, useState } from "react";
import { GPU_INSTALL_PROGRESS_CHANNEL, type GpuEngine, type GpuInstallPhase, type GpuStatus } from "../../../../shared/gpu";
import { useTranslation } from "../../i18n";
import { invokeIpc, onIpc } from "../../lib/ipc";

const ENGINES = ["meiki", "firered", "whisper"] as const;
const CUDA_URL = "https://developer.nvidia.com/cuda-12-9-1-download-archive";
const CUDNN_URL = "https://developer.nvidia.com/cudnn-downloads";

export function GpuSettings({ active }: { active: boolean }) {
  const t = useTranslation();
  const [status, setStatus] = useState<GpuStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [installPhase, setInstallPhase] = useState<GpuInstallPhase | null>(null);
  const changing = useRef(false);
  const installing = useRef(false);
  const actionError = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(true);
  const refresh = useCallback(async (force = false) => {
    if (changing.current) return;
    if (force) actionError.current = false;
    const started = generation.current;
    try {
      const next = await invokeIpc<GpuStatus>("settings.gpu", { refresh: force });
      if (!next?.settings || !next?.diagnostics || !next?.runtime || !next?.availability) throw new Error(t("settings.gpu.unavailable"));
      if (mounted.current && started === generation.current && !changing.current) {
        setStatus(next);
        if (!actionError.current) setError("");
      }
    } catch (cause) {
      if (mounted.current && started === generation.current) setError(String(cause));
    }
  }, [t]);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => onIpc(GPU_INSTALL_PROGRESS_CHANNEL, (_event, payload) => {
    const phase = (payload as { phase?: GpuInstallPhase } | null)?.phase;
    if (installing.current && phase && ["stopping", "installing", "starting"].includes(phase)) setInstallPhase(phase);
  }), []);
  useEffect(() => {
    if (!active) return;
    void refresh(true);
    const timer = setInterval(() => void refresh(), 5000);
    const focus = () => void refresh(true);
    window.addEventListener("focus", focus);
    return () => { clearInterval(timer); window.removeEventListener("focus", focus); };
  }, [active, refresh]);
  async function change(engine: GpuEngine, enabled: boolean) {
    if (changing.current) return;
    changing.current = true;
    actionError.current = false;
    setError("");
    generation.current += 1;
    setBusy(true);
    try {
      const next = await invokeIpc<GpuStatus>("settings.gpu", { settings: { [engine]: enabled } });
      if (!next?.settings || !next?.diagnostics || !next?.runtime || !next?.availability) throw new Error(t("settings.gpu.unavailable"));
      if (mounted.current) { setStatus(next); setError(""); }
    } catch (cause) {
      actionError.current = true;
      if (mounted.current) setError(String(cause));
    } finally {
      changing.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  async function install(mode: "engine" | "libraries" | "remove") {
    if (changing.current) return;
    let success = false;
    setBusy(true);
    changing.current = true;
    installing.current = true;
    actionError.current = false;
    setError("");
    setInstallPhase("stopping");
    generation.current += 1;
    try {
      const result = await invokeIpc<{ success: boolean; message: string }>(
        mode === "remove" ? "python.uninstallCudaPackage" : "python.installCudaPackage",
        { bundledLibraries: mode === "libraries" },
      );
      if (!result.success) throw new Error(result.message);
      success = true;
      setError("");
    } catch (cause) {
      actionError.current = true;
      if (mounted.current) setError(String(cause));
    }
    finally {
      changing.current = false;
      installing.current = false;
      if (mounted.current) { setBusy(false); setInstallPhase(null); if (success) void refresh(true); }
    }
  }
  function actualDevice(engine: GpuEngine) {
    const records = status?.runtime[engine] || [];
    if (!records.length) return t("settings.gpu.notLoaded");
    if (records.some((record) => record.enabled !== status?.settings[engine])) return t("settings.gpu.pending");
    const devices = new Set(records.map((record) => record.device));
    return t(devices.size > 1 ? "settings.gpu.mixed" : devices.has("cuda") ? "settings.gpu.loadedGpu" : "settings.gpu.loadedCpu");
  }
  const libraries = status?.diagnostics.libraries;
  const cudaReady = Boolean(libraries?.cublas.available && libraries?.cublasLt.available && libraries?.cudart.available && libraries?.cufft.available);
  const systemReady = cudaReady && Boolean(libraries?.cudnn.available);
  return <div className="settings-form-width gpu-settings">
    <section className="ws-section">
      <h2>{t("settings.gpu.setup")}</h2>
      <p className="ws-section-description">{t("settings.gpu.intro")}</p>
      {error ? <div className="ws-notice is-error" role="alert">{error}</div> : null}
      <div className="gpu-checks" role="status">
        {([
          ["driver", Boolean(status?.diagnostics.driver.available)],
          ["cuda", cudaReady], ["cudnn", Boolean(libraries?.cudnn.available)],
          ["onnx", Boolean(status?.diagnostics.onnx.available)],
          ["whisper", Boolean(status?.diagnostics.whisper.available)],
        ] as const).map(([key, ready]) => <div key={key} className="gpu-check">
          <strong>{t("settings.gpu.checks." + key)}</strong>
          <span className={ready ? "gpu-ready" : "gpu-missing"}>{t(!status ? "settings.gpu.checking" : ready ? "settings.gpu.available" : "settings.gpu.missing")}</span>
        </div>)}
      </div>
      {status?.diagnostics.driver.name ? <p>{status.diagnostics.driver.name}</p> : null}
      <div className="gpu-actions">
        <button type="button" onClick={() => void invokeIpc("open-external", CUDA_URL)}>{t("settings.gpu.downloadCuda")}</button>
        <button type="button" onClick={() => void invokeIpc("open-external", CUDNN_URL)}>{t("settings.gpu.downloadCudnn")}</button>
        <button type="button" disabled={busy} onClick={() => void refresh(true)}>{t("settings.gpu.refresh")}</button>
      </div>
      <p className="ws-section-description">{t("settings.gpu.installHint")}</p>
    </section>
    <section className="ws-section">
      <h2>{t("settings.gpu.engines")}</h2>
      <p className="ws-section-description">{t("settings.gpu.shared")}</p>
      {ENGINES.map((engine) => <div className="gpu-engine" key={engine}>
        <div className="gpu-engine-heading">
          <label htmlFor={"gpu-" + engine}>{t("settings.gpu.names." + engine)}</label>
          <div className="gpu-switch">
            <span>{t(status?.settings[engine] ? "settings.gpu.enabled" : "settings.gpu.disabled")}</span>
            <input id={"gpu-" + engine} type="checkbox" role="switch" checked={Boolean(status?.settings[engine])}
              disabled={busy || !status} onChange={(event) => void change(engine, event.target.checked)} />
          </div>
        </div>
        <p>{t("settings.gpu.help." + engine)}</p>
        <div className="gpu-engine-state">
          <strong>{actualDevice(engine)}</strong>
          {status?.settings[engine] ? <span>{t("settings.gpu.reasons." + status.availability[engine])}</span> : null}
        </div>
        {status?.runtime[engine]?.filter((record) => record.error).map((record) => <p role="alert" key={record.pid}>{t("settings.gpu.fallback", { error: record.error })}</p>)}
      </div>)}
      <p className="ws-section-description">{t("settings.gpu.otherEngines")}</p>
    </section>
    <section className="ws-section">
      <h2>{t("settings.gpu.enginePackage")}</h2>
      <p className="ws-section-description">{t("settings.gpu.enginePackageHelp")}</p>
      <div className="gpu-actions">
        <button type="button" disabled={busy || !status || !systemReady || !status.diagnostics.driver.available} onClick={() => void install("engine")}>{t("settings.gpu.installEngine")}</button>
        <button type="button" disabled={busy || !status} onClick={() => void install("remove")}>{t("settings.gpu.removeEngine")}</button>
      </div>
      <details>
        <summary>{t("settings.gpu.fallbackTitle")}</summary>
        <p>{t("settings.gpu.fallbackHelp")}</p>
        <button type="button" disabled={busy || !status} onClick={() => void install("libraries")}>{t("settings.gpu.installLibraries")}</button>
      </details>
      <details>
        <summary>{t("settings.gpu.details")}</summary>
        {Object.entries(libraries || {}).map(([name, library]) => <p key={name} className="gpu-library-path">
          <strong>{name}</strong>: {library.path || t("settings.gpu.missing")}
          {library.source ? " · " + t("settings.gpu.sources." + library.source) : ""}
          {library.error ? " · " + library.error : ""}
        </p>)}
      </details>
      {busy ? <p role="status">{t(installPhase ? "settings.gpu.progress." + installPhase : "settings.gpu.working")}</p> : null}
    </section>
  </div>;
}
