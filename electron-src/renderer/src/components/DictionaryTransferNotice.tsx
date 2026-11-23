import { useEffect, useState } from "react";
import type { ReaderDictionaryTransfer } from "../../../shared/reader";
import { useLocale, useTranslation } from "../i18n";
import { invokeIpc, onIpc } from "../lib/ipc";
import { retainEqual } from "../lib/visiblePolling";

export function DictionaryTransferNotice() {
  const [transfers, setTransfers] = useState<ReaderDictionaryTransfer[]>([]);
  const t = useTranslation();
  const [locale] = useLocale();

  useEffect(() => {
    let revision = 0;
    const refresh = () => {
      const request = ++revision;
      void invokeIpc<ReaderDictionaryTransfer[]>("reader.dictionaryTransfers").then(value => {
        if (request === revision && Array.isArray(value)) {
          setTransfers(before => retainEqual(before, value));
        }
      }).catch(() => { /* An older desktop host may not expose transfer status. */ });
    };
    const stop = onIpc("reader.dictionaryTransfersChanged", refresh);
    refresh();
    return () => {
      revision++;
      stop();
    };
  }, []);

  return transfers.map(({ name, phase, records }) => (
    <div key={name} className={phase === "failed" ? "alert alert-error" : "alert alert-info"} role="status">
      <span>{t(`reader.transfer.${phase}`, { name, count: records.toLocaleString(locale === "ukr" ? "uk" : locale) })}</span>
    </div>
  ));
}
