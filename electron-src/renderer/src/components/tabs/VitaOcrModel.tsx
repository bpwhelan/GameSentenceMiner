import { useCallback, useEffect, useRef, useState } from "react";
import type { VitaModelSize, VitaModelStatus } from "../../../../shared/vita_ocr";
import { useTranslation } from "../../i18n";
import { invokeIpc } from "../../lib/ipc";

export function VitaOcrModel() {
  const t = useTranslation();
  const [status, setStatus] = useState<VitaModelStatus | null>(null);
  const [pending, setPending] = useState<VitaModelSize | null>(null);
  const [error, setError] = useState("");
  const changing = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const attemptedSetup = useRef(false);
  const refresh = useCallback(async () => {
    if (changing.current) return;
    const started = generation.current;
    try {
      const next = await invokeIpc<VitaModelStatus>("ocr.vita-model", {});
      if (mounted.current && !changing.current && started === generation.current && next) {
        setStatus(next);
        setError(next.error || "");
      }
    } catch (cause) {
      if (mounted.current && !changing.current && started === generation.current) setError(String(cause));
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    window.addEventListener("focus", refresh);
    return () => {
      mounted.current = false;
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);
  useEffect(() => {
    if (status && !status.available && !status.busy && status.supported !== false && !attemptedSetup.current) {
      attemptedSetup.current = true;
      void select(status.model);
    }
  }, [status]);
  async function select(model: VitaModelSize) {
    generation.current += 1;
    changing.current = true;
    setPending(model);
    setError("");
    try {
      const next = await invokeIpc<VitaModelStatus>("ocr.vita-model", { model });
      if (mounted.current && next) {
        setStatus(next);
        setError(next.error || "");
      }
    } catch (cause) {
      if (mounted.current) setError(String(cause));
    } finally {
      changing.current = false;
      if (mounted.current) {
        setPending(null);
      }
    }
  }
  return (
    <div className="input-group ocr-pipeline-control">
      <label htmlFor="ocr-vita-model">{t("ocr.vitaModel.label")}</label>
      <select id="ocr-vita-model" value={pending || status?.model || "normal"}
        disabled={Boolean(pending) || !status || status.supported === false || status.busy}
        onChange={(event) => void select(event.target.value as VitaModelSize)}>
        {(["small", "normal", "large"] as const).map((size) => (
          <option key={size} value={size}>{t("ocr.vitaModel." + size)}</option>
        ))}
      </select>
      <small>{t("ocr.vitaModel.help")}</small>
      <small role="status">{pending || status?.busy ? t("ocr.vitaModel.preparing") : status?.available
        ? t("ocr.vitaModel.active", { model: t("ocr.vitaModel." + status.model) })
        : t("ocr.vitaModel.unavailable")}</small>
      {error ? <small role="alert">{t("ocr.vitaModel.error", { error })}</small> : null}
      {error ? <button type="button" onClick={() => void (status && !status.available && status.supported !== false
        ? select(status.model) : refresh())} disabled={Boolean(pending) || status?.busy}>
        {t("ocr.vitaModel.refresh")}
      </button> : null}
    </div>
  );
}
