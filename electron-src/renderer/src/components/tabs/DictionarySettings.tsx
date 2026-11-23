import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "../../i18n";
import { invokeIpc, onIpc } from "../../lib/ipc";

type Reader = "yomitan" | "hachidori";
type BrowserSource = {
  browser: string;
  profile: string;
  directory: string;
  id: string;
  reader: Reader;
  direct: boolean;
};

type DictionaryState = {
  reader: Reader;
  browserImport: {
    supported: boolean;
    selection: Partial<Record<Reader, string>>;
  };
};

function readerName(reader: Reader) {
  return reader === "hachidori" ? "Hachidori" : "Yomitan";
}

export function DictionarySettings({ active }: { active: boolean }) {
  const t = useTranslation();
  const [settings, setSettings] = useState<DictionaryState>();
  const [sources, setSources] = useState<BrowserSource[]>();
  const [source, setSource] = useState<BrowserSource>();
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setSettings(await invokeIpc<DictionaryState>("dictionary.settings"));
  }, []);

  useEffect(() => {
    if (!active) return;
    const report = (reason: unknown) => setError(String(reason));
    const offSwitch = onIpc("dictionary-reader-switching", (_event, value) => {
      setSwitching(value === true);
      if (value === false) void refresh().catch(report);
    });
    const offError = onIpc("dictionary-reader-error", (_event, value) => report(value));
    setSwitching(false);
    void refresh().catch(report);
    return () => { offSwitch(); offError(); };
  }, [active, refresh]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try { await action(); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  }

  async function scan(channel: "dictionary.browserSources" | "dictionary.browseProfile") {
    const found = await invokeIpc<BrowserSource[] | null>(channel);
    if (!found) return;
    setSources(found);
    setSource(undefined);
  }

  const reader = settings?.reader ?? "yomitan";
  const unavailable = busy || switching || !settings;
  return <div className="settings-form-width">
    <section className="ws-section">
      <label className="input-group">
        <span>{t("settings.dictionary.reader")}</span>
        <select className="select" value={reader} disabled={unavailable} onChange={event => {
          const next = event.currentTarget.value as Reader;
          setSwitching(true);
          void run(async () => {
            try {
              await invokeIpc("dictionary.select", next);
              await refresh();
            } catch (reason) {
              setSwitching(false);
              throw reason;
            }
          });
        }}>
          <option value="yomitan">{readerName("yomitan")}</option>
          <option value="hachidori">{readerName("hachidori")}</option>
        </select>
      </label>
      <div className="ws-header-actions">
        <button className="btn btn-sm" disabled={unavailable} onClick={() => void run(async () => {
          await invokeIpc("dictionary.openSettings");
        })}>{t("settings.dictionary.openReader", { name: readerName(reader) })}</button>
        <button className="btn btn-sm" disabled={unavailable} onClick={() => void run(async () => {
          await invokeIpc("dictionary.openJitenSettings");
        })}>{t("settings.dictionary.openJiten")}</button>
      </div>
      {switching && <p role="status">{t("onboarding.switching")}</p>}
    </section>
    {settings?.browserImport.supported && <section className="ws-section">
      <h2>{t("settings.dictionary.browserImport")}</h2>
      <p>{t("settings.dictionary.browserHint")}</p>
      <div className="ws-header-actions">
        <button className="btn btn-sm" disabled={unavailable} onClick={() => void run(() => scan("dictionary.browserSources"))}>
          {t("settings.dictionary.scan")}
        </button>
        <button className="btn btn-sm" disabled={unavailable} onClick={() => void run(() => scan("dictionary.browseProfile"))}>
          {t("settings.dictionary.browse")}
        </button>
      </div>
      {sources?.length === 0 && <p role="status">{t("settings.dictionary.noSources")}</p>}
      {sources && sources.length > 0 && <label className="input-group">
        <span>{t("settings.dictionary.source")}</span>
        <select className="select" disabled={unavailable} value={source ? sources.indexOf(source) : ""}
          onChange={event => setSource(event.currentTarget.value === "" ? undefined : sources[Number(event.currentTarget.value)])}>
          <option value="">{t("settings.dictionary.chooseSource")}</option>
          {sources.map((item, index) => <option key={`${item.directory}|${item.id}`} value={index}>
            {t("settings.dictionary.sourceLabel", {
              browser: item.browser || t("settings.dictionary.customProfile"),
              profile: item.profile,
              name: readerName(item.reader),
            })}
          </option>)}
        </select>
      </label>}
      {source && (source.direct ? <>
        <p>{t("settings.dictionary.importHint", { name: readerName(source.reader) })}</p>
        <button className="btn btn-sm btn-primary" disabled={unavailable} onClick={() => void run(async () => {
          await invokeIpc("dictionary.importBrowser", { directory: source.directory, id: source.id });
          await refresh();
        })}>{t("settings.dictionary.importAction")}</button>
      </> : <p>{t("settings.dictionary.firefoxHint")}</p>)}
      {(["yomitan", "hachidori"] as const).filter(name => settings.browserImport.selection[name]).map(name =>
        <button key={name} className="btn btn-sm" disabled={unavailable} onClick={() => void run(async () => {
          await invokeIpc("dictionary.useOriginal", name);
          await refresh();
        })}>{t("settings.dictionary.useOriginal", { name: readerName(name) })}</button>
      )}
    </section>}
    {error && <p className="alert alert-error" role="alert">{t("settings.dictionary.error", { message: error })}</p>}
  </div>;
}
