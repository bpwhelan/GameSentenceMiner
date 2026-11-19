import { useEffect, useState } from "react";
import { useLocale, useTranslation } from "../../i18n";
import { startVisiblePolling } from "../../lib/visiblePolling";

const groupLabels = {
  desktop: "settings.resources.desktop",
  webview: "settings.resources.webview",
  backend: "settings.resources.backend",
  overlay: "settings.resources.overlay",
  textHook: "settings.resources.textHook",
  capture: "settings.resources.capture",
} as const;

interface ResourceRow {
  group: keyof typeof groupLabels;
  cpuPercent: number | null;
  privateWorkingSetBytes: number | null;
}

function total(rows: ResourceRow[], field: "cpuPercent" | "privateWorkingSetBytes") {
  let sum = 0;
  for (const row of rows) {
    const value = row[field];
    if (value === null) return null;
    sum += value;
  }
  return sum;
}

export function ResourceUsage() {
  const t = useTranslation();
  const [locale] = useLocale();
  const [rows, setRows] = useState<ResourceRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    const stop = startVisiblePolling(async () => {
      try {
        const next = await window.__GSM_INVOKE__!<ResourceRow[]>("desktop_resource_usage", {});
        if (!disposed) {
          setRows(next);
          setFailed(false);
        }
      } catch {
        if (!disposed) setFailed(true);
      }
    }, 3000);
    return () => {
      disposed = true;
      stop();
    };
  }, []);

  const number = new Intl.NumberFormat(locale === "ukr" ? "uk" : locale, { maximumFractionDigits: 1 });
  const cpu = (value: number | null) => value === null
    ? t("settings.resources.unavailable")
    : t("settings.resources.cpuValue", { value: number.format(value) });
  const memory = (value: number | null) => value === null
    ? t("settings.resources.unavailable")
    : t("settings.resources.memoryValue", { value: number.format(value / 2 ** 20) });

  return (
    <div className="settings-form-width">
      <p>{t("settings.resources.scope")}</p>
      {failed ? <p role="status">{t("settings.resources.failed")}</p> : !rows ? (
        <p role="status">{t("settings.resources.measuring")}</p>
      ) : (
        <table className="settings-resource-table" aria-label={t("settings.resources.title")}>
          <thead>
            <tr>
              <th scope="col">{t("settings.resources.component")}</th>
              <th scope="col">{t("settings.resources.cpu")}</th>
              <th scope="col">{t("settings.resources.memory")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.group}>
                <th scope="row">{t(groupLabels[row.group])}</th>
                <td>{cpu(row.cpuPercent)}</td>
                <td>{memory(row.privateWorkingSetBytes)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{t("settings.resources.total")}</th>
              <td>{cpu(total(rows, "cpuPercent"))}</td>
              <td>{memory(total(rows, "privateWorkingSetBytes"))}</td>
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}
