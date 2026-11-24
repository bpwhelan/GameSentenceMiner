import { Fragment, useEffect, useState } from "react";
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

const processLabels = {
  browser: "settings.resources.process.browser",
  gpu: "settings.resources.process.gpu",
  renderer: "settings.resources.process.renderer",
  extension: "settings.resources.process.extension",
  utility: "settings.resources.process.utility",
  other: "settings.resources.process.other",
} as const;

const windowLabels = {
  "gsm-hub": "settings.resources.desktop",
  "gsm-overlay-main": "settings.resources.window.overlay",
  "gsm-overlay-settings": "settings.resources.window.overlaySettings",
  "gsm-dictionary-controller": "settings.resources.window.dictionaryController",
  "gsm-dictionary-search": "settings.resources.window.dictionarySearch",
  "gsm-reader-lookup": "settings.resources.window.readerLookup",
} as const;

const categoryLabels = {
  ocr: "settings.resources.model.ocr",
  vad: "settings.resources.model.vad",
  dictionary: "settings.resources.model.dictionary",
} as const;

interface ProcessUsage {
  cpuPercent: number | null;
  privateWorkingSetBytes: number | null;
  privateCommitBytes?: number | null;
}

interface WebviewProcess extends ProcessUsage {
  pid: number;
  kind: keyof typeof processLabels;
  windowLabels: string[];
}

interface ResourceRow extends ProcessUsage {
  group: keyof typeof groupLabels;
  processes?: WebviewProcess[];
}

interface ModelUsage {
  id: string;
  category: keyof typeof categoryLabels;
  name: string;
  detail: string | null;
  instances: number;
  fileBytes: number;
  estimatedRamBytes: number | null;
  idleSeconds: number;
  unloadsOnIdle: boolean;
  storage: string;
}

interface ExtensionUsage {
  id: string;
  name: string;
  enabled: boolean;
  kind?: "hachidori";
}

interface ResourceSnapshot {
  groups: ResourceRow[];
  models: ModelUsage[];
  extensions: ExtensionUsage[] | null;
}

interface DictionaryMemory {
  heapBytes: number;
  useLessRamByDefault: boolean | null;
  dictionaries: { id: string; title: string; residentHashBytes: number; hashIndexStorage: string }[];
}

function total(rows: ResourceRow[], field: keyof ProcessUsage) {
  let sum = 0;
  for (const row of rows) {
    const value = row[field];
    if (value == null) return null;
    sum += value;
  }
  return sum;
}

export function ResourceUsage() {
  const t = useTranslation();
  const [locale] = useLocale();
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null);
  const [failed, setFailed] = useState(false);
  const [inspection, setInspection] = useState<DictionaryMemory | "loading" | "failed" | null>(null);
  useEffect(() => {
    let disposed = false;
    const stop = startVisiblePolling(async () => {
      try {
        const next = await window.__GSM_INVOKE__!<ResourceSnapshot | ResourceRow[]>("desktop_resource_usage", {});
        if (!disposed) {
          setSnapshot(Array.isArray(next) ? { groups: next, models: [], extensions: null } : next);
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

  const formatLocale = locale === "ukr" ? "uk" : locale;
  const number = new Intl.NumberFormat(formatLocale, { maximumFractionDigits: 1 });
  const cpu = (value: number | null) => value === null
    ? t("settings.resources.unavailable")
    : t("settings.resources.cpuValue", { value: number.format(value) });
  const memory = (value: number | null | undefined) => value == null
    ? t("settings.resources.unavailable")
    : t("settings.resources.memoryValue", { value: number.format(value / 2 ** 20) });

  const rows = snapshot?.groups;
  const hasCommit = rows?.some(row => row.privateCommitBytes !== undefined);
  const canInspect = snapshot?.extensions?.some(extension => extension.kind === "hachidori" && extension.enabled);
  const inspect = async () => {
    setInspection("loading");
    try {
      setInspection(await window.__GSM_INVOKE__!<DictionaryMemory>("desktop_hachidori_memory", {}));
    } catch {
      setInspection("failed");
    }
  };

  return (
    <div className="settings-resource-usage">
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
              {hasCommit && <th scope="col">{t("settings.resources.commit")}</th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <Fragment key={row.group}>
                <tr>
                  <th scope="row">{t(groupLabels[row.group])}</th>
                  <td>{cpu(row.cpuPercent)}</td>
                  <td>{memory(row.privateWorkingSetBytes)}</td>
                  {hasCommit && <td>{memory(row.privateCommitBytes)}</td>}
                </tr>
                {row.processes?.slice().sort((a, b) => (b.privateWorkingSetBytes ?? 0) - (a.privateWorkingSetBytes ?? 0)).map(process => (
                  <tr key={process.pid} className="settings-resource-process">
                    <th scope="row">
                      {t(processLabels[process.kind])}
                      {process.windowLabels.length > 0 && <small>{process.windowLabels.map(label => {
                        const key = windowLabels[label as keyof typeof windowLabels];
                        return key ? t(key) : label;
                      }).join(", ")}</small>}
                      <small>{t("settings.resources.process.pid", { value: String(process.pid) })}</small>
                    </th>
                    <td>{cpu(process.cpuPercent)}</td>
                    <td>{memory(process.privateWorkingSetBytes)}</td>
                    {hasCommit && <td>{memory(process.privateCommitBytes)}</td>}
                  </tr>
                ))}
              </Fragment>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">{t("settings.resources.total")}</th>
              <td>{cpu(total(rows, "cpuPercent"))}</td>
              <td>{memory(total(rows, "privateWorkingSetBytes"))}</td>
              {hasCommit && <td>{memory(total(rows, "privateCommitBytes"))}</td>}
            </tr>
          </tfoot>
        </table>
      )}
      {snapshot && (
        <>
          {hasCommit && <p>{t("settings.resources.memoryScope")}</p>}
          <section aria-labelledby="resources-models">
            <h3 id="resources-models">{t("settings.resources.model.title")}</h3>
            {snapshot.models.length === 0 ? <p>{t("settings.resources.model.empty")}</p> : (
              <>
                <p>{t("settings.resources.model.scope")}</p>
                <table className="settings-resource-table" aria-labelledby="resources-models">
                  <thead><tr>
                    <th scope="col">{t("settings.resources.model.name")}</th>
                    <th scope="col">{t("settings.resources.model.files")}</th>
                    <th scope="col">{t("settings.resources.model.estimate")}</th>
                    <th scope="col">{t("settings.resources.model.idle")}</th>
                  </tr></thead>
                  <tbody>{snapshot.models.map(model => (
                    <tr key={model.id}>
                      <th scope="row">
                        {model.name}{model.detail && <small>{model.detail}</small>}
                        <small>{t(categoryLabels[model.category])}</small>
                        {model.storage === "mmap" && <small>{t("settings.resources.model.mapped")}</small>}
                        {model.instances > 1 && <small>{t("settings.resources.model.instances", { value: number.format(model.instances) })}</small>}
                      </th>
                      <td>{memory(model.fileBytes || null)}</td>
                      <td>{memory(model.estimatedRamBytes)}</td>
                      <td>
                        {t("settings.resources.model.seconds", { value: number.format(model.idleSeconds) })}
                        <small>{t(model.unloadsOnIdle ? "settings.resources.model.unloads" : "settings.resources.model.persistent")}</small>
                      </td>
                    </tr>
                  ))}</tbody>
                </table>
              </>
            )}
          </section>
          <section aria-labelledby="resources-extensions">
            <h3 id="resources-extensions">{t("settings.resources.extensions.title")}</h3>
            {!snapshot.extensions?.length ? (
              <p>{t(snapshot.extensions ? "settings.resources.extensions.empty" : "settings.resources.extensions.unavailable")}</p>
            ) : (
              <table className="settings-resource-table" aria-labelledby="resources-extensions">
                <thead><tr>
                  <th scope="col">{t("settings.resources.extensions.name")}</th>
                  <th scope="col">{t("settings.resources.extensions.status")}</th>
                </tr></thead>
                <tbody>{snapshot.extensions.map(extension => (
                  <tr key={extension.id}>
                    <th scope="row">{extension.name}</th>
                    <td>{t(extension.enabled ? "settings.resources.extensions.enabled" : "settings.resources.extensions.disabled")}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
            {canInspect && (
              <>
                <button type="button" className="btn btn-outline-secondary" onClick={() => void inspect()} disabled={inspection === "loading"}>
                  {t("settings.resources.dictionary.inspect")}
                </button>
                {inspection === "loading" && <p role="status">{t("settings.resources.measuring")}</p>}
                {inspection === "failed" && <p role="status">{t("settings.resources.dictionary.failed")}</p>}
                {inspection && typeof inspection === "object" && (
                  <>
                    <p>{t("settings.resources.dictionary.heap", { value: memory(inspection.heapBytes) })}</p>
                    <p>{t("settings.resources.dictionary.lowRam", {
                      value: t(inspection.useLessRamByDefault === null ? "settings.resources.unavailable" : inspection.useLessRamByDefault
                        ? "settings.resources.extensions.enabled" : "settings.resources.extensions.disabled"),
                    })}</p>
                    {inspection.dictionaries.length === 0 ? <p>{t("settings.resources.dictionary.empty")}</p> : (
                      <table className="settings-resource-table" aria-label={t("settings.resources.dictionary.inspect")}>
                        <thead><tr>
                          <th scope="col">{t("settings.resources.model.dictionary")}</th>
                          <th scope="col">{t("settings.resources.dictionary.residentHash")}</th>
                        </tr></thead>
                        <tbody>{inspection.dictionaries.map(dictionary => (
                          <tr key={dictionary.id}>
                            <th scope="row">{dictionary.title}</th>
                            <td>{memory(dictionary.residentHashBytes)}<small>{t(dictionary.hashIndexStorage === "paged"
                              ? "settings.resources.dictionary.paged" : "settings.resources.dictionary.resident")}</small></td>
                          </tr>
                        ))}</tbody>
                      </table>
                    )}
                  </>
                )}
              </>
            )}
          </section>
        </>
      )}
    </div>
  );
}
