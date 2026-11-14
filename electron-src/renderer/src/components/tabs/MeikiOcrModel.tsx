import { useCallback, useEffect, useRef, useState } from "react";
import type { MeikiModelSize, MeikiModelStatus } from "../../../../shared/meiki_ocr";
import { useTranslation } from "../../i18n";
import { invokeIpc } from "../../lib/ipc";
import { retainEqual, startVisiblePolling } from '../../lib/visiblePolling';

export function MeikiOcrModel({ active = true }: { active?: boolean }) {
  const t = useTranslation();
  const [status, setStatus] = useState<MeikiModelStatus | null>(null);
  const [pending, setPending] = useState<MeikiModelSize | null>(null);
  const [error, setError] = useState("");
  const changing = useRef(false);
  const generation = useRef(0);
  const mounted = useRef(false);
  const refresh = useCallback(async () => {
    if (changing.current) return;
    const started = generation.current;
    try {
      const next = await invokeIpc<MeikiModelStatus>("ocr.meiki-model", {});
      if (mounted.current && !changing.current && started === generation.current && next) {
        setStatus(before => retainEqual(before, next));
        setError(next.error || "");
      }
    } catch (cause) {
      if (mounted.current && !changing.current && started === generation.current) setError(String(cause));
    }
  }, []);
  useEffect(() => {
    if (!active) return;
    mounted.current = true;
    const stop = startVisiblePolling(refresh, 3000);
    window.addEventListener("focus", refresh);
    return () => {
      mounted.current = false;
      stop();
      window.removeEventListener("focus", refresh);
    };
  }, [active, refresh]);
  async function select(model: MeikiModelSize) {
    generation.current += 1;
    changing.current = true;
    setPending(model);
    setError("");
    try {
      const next = await invokeIpc<MeikiModelStatus>("ocr.meiki-model", { model });
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
      <label htmlFor="ocr-meiki-model">{t("ocr.meikiModel.label")}</label>
      <select id="ocr-meiki-model" value={pending || status?.model || "large"}
        disabled={Boolean(pending) || !status?.available || status.busy}
        onChange={(event) => void select(event.target.value as MeikiModelSize)}>
        {(["small", "large"] as const).map((size) => (
          <option key={size} value={size}>{t("ocr.meikiModel." + size)}</option>
        ))}
      </select>
      <small>{t("ocr.meikiModel.help")}</small>
      <small role="status">{pending || status?.busy ? t("ocr.meikiModel.preparing") : status?.available
        ? t("ocr.meikiModel.active", { model: t("ocr.meikiModel." + status.model) })
        : t("ocr.meikiModel.unavailable")}</small>
      {error ? <small role="alert">{t("ocr.meikiModel.error", { error })}</small> : null}
      {error ? <button type="button" onClick={() => void refresh()} disabled={Boolean(pending)}>
        {t("ocr.meikiModel.refresh")}
      </button> : null}
    </div>
  );
}
