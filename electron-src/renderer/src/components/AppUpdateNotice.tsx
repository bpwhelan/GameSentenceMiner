import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { APP_UPDATE_STATUS_CHANNEL, type AppUpdateStatus } from "../../../shared/app_update";
import type { DesktopUpdateChangelogSnapshot } from "../../../shared/changelog";
import { useTranslation } from "../i18n";
import { WhatsChangedDialog } from "./WhatsChangedDialog";

type UpdateOffer = {
  status: AppUpdateStatus;
  changelog: DesktopUpdateChangelogSnapshot;
};

export function AppUpdateNotice() {
  const t = useTranslation();
  const [status, setStatus] = useState<AppUpdateStatus | null>(null);
  const [offer, setOffer] = useState<UpdateOffer | null>(null);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState(false);
  const requestId = useRef(0);
  const installingRef = useRef(false);

  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const refresh = () => {
      const currentRevision = ++revision;
      void window.ipcRenderer.invoke<AppUpdateStatus | null>("settings.getAppUpdateStatus")
        .then((snapshot) => {
          if (!disposed && revision === currentRevision) setStatus(snapshot);
        })
        .catch(() => { /* Keep the last known status if the bridge is temporarily unavailable. */ });
    };
    const offStatus = window.ipcRenderer.on(APP_UPDATE_STATUS_CHANNEL, (_event, payload) => {
      revision += 1;
      setStatus(payload as AppUpdateStatus);
    });
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      disposed = true;
      requestId.current += 1;
      offStatus();
      window.removeEventListener("focus", refresh);
    };
  }, []);

  const loadNotes = useCallback(async (reviewedStatus: AppUpdateStatus) => {
    const currentRequest = ++requestId.current;
    const loading: DesktopUpdateChangelogSnapshot = {
      fromVersion: reviewedStatus.currentVersion,
      toVersion: reviewedStatus.latestVersion!,
      status: "loading",
      source: null,
      title: "",
      markdown: "",
      assetBaseUrl: "",
      error: null
    };
    setOffer({ status: reviewedStatus, changelog: loading });
    try {
      const changelog = await window.ipcRenderer.invoke<DesktopUpdateChangelogSnapshot | null>(
        "settings.getAppUpdateChangelog"
      );
      if (!changelog || changelog.fromVersion !== loading.fromVersion || changelog.toVersion !== loading.toVersion) {
        throw new Error("The release notes no longer match the selected update.");
      }
      if (requestId.current === currentRequest) setOffer({ status: reviewedStatus, changelog });
    } catch {
      if (requestId.current === currentRequest) {
        setOffer({ status: reviewedStatus, changelog: { ...loading, status: "failed" } });
      }
    }
  }, []);

  const busy = installing || status?.downloading === true;
  const offerChanged = Boolean(offer && (
    !status?.updateAvailable ||
    status.latestVersion !== offer.status.latestVersion ||
    status.channel !== offer.status.channel ||
    Boolean(status.preview) !== Boolean(offer.status.preview)
  ));

  const closeOffer = useCallback(() => {
    if (busy) return;
    requestId.current += 1;
    setOffer(null);
    setInstallError(false);
  }, [busy]);

  const acceptUpdate = async () => {
    if (!offer || offer.status.preview || busy || offerChanged || installingRef.current || status?.checking) return;
    installingRef.current = true;
    setInstalling(true);
    setInstallError(false);
    try {
      const nextStatus = await window.ipcRenderer.invoke<AppUpdateStatus | null>(
        "settings.installAppUpdate", offer.status.latestVersion
      );
      if (!nextStatus) throw new Error("No update status was returned.");
      setStatus(nextStatus);
      setInstallError(Boolean(nextStatus.error));
    } catch {
      setInstallError(true);
    } finally {
      installingRef.current = false;
      setInstalling(false);
    }
  };

  return (
    <>
      {status?.updateAvailable && status.latestVersion ? (
        <button
          type="button"
          className="icon-link app-update-notice"
          aria-label={t("app.update.available")}
          aria-haspopup="dialog"
          data-tip={t("app.update.availableVersion", { version: status.latestVersion })}
          onClick={() => {
            setInstallError(false);
            void loadNotes(status);
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4" />
          </svg>
          <span>{t("app.update.available")}</span>
        </button>
      ) : null}
      {offer ? createPortal(
        <WhatsChangedDialog
          changelog={offer.changelog}
          installSession={null}
          backendStatus="completed"
          requiresBackendSync={false}
          onContinue={closeOffer}
          onRetry={() => void loadNotes(offer.status)}
          onOpenLogs={() => void window.ipcRenderer.invoke("logs.openFolder")}
          onQuit={() => window.ipcRenderer.send("app-close")}
          updateOffer={{
            busy,
            disabled: offerChanged || status?.checking === true || offer.status.preview === true,
            changed: offerChanged,
            preview: offer.status.preview,
            error: installError || Boolean(status?.error),
            onAccept: () => void acceptUpdate()
          }}
        />,
        document.body
      ) : null}
    </>
  );
}
