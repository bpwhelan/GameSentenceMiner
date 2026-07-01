import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

import { useTranslation } from "../i18n";
import type { DesktopUpdateChangelogSnapshot } from "../../../shared/changelog";
import type { InstallSessionSnapshot } from "../../../shared/install_session";

function formatPercent(value: number): string {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

function isAbsoluteAssetUrl(value: string): boolean {
  return /^(?:https?:|data:|blob:|gsm-changelog:)/i.test(value);
}

function resolveAssetUrl(src: string | undefined, assetBaseUrl: string): string {
  if (!src) {
    return "";
  }
  if (isAbsoluteAssetUrl(src)) {
    return src;
  }
  const cleanBase = assetBaseUrl.endsWith("/") ? assetBaseUrl : `${assetBaseUrl}/`;
  const cleanSrc = src.replace(/^\.?\//, "");
  return `${cleanBase}${cleanSrc}`;
}

export function WhatsChangedDialog({
  changelog,
  installSession,
  backendStatus,
  onContinue,
  onRetry,
  onOpenLogs,
  onQuit
}: {
  changelog: DesktopUpdateChangelogSnapshot;
  installSession: InstallSessionSnapshot | null;
  backendStatus: "pending" | "running" | "completed" | "failed";
  onContinue: () => void;
  onRetry: () => void;
  onOpenLogs: () => void;
  onQuit: () => void;
}) {
  const t = useTranslation();
  const isFailed = backendStatus === "failed";
  const canContinue = backendStatus === "completed";
  const progress =
    installSession && typeof installSession.overallProgress === "number"
      ? installSession.overallProgress
      : backendStatus === "completed"
        ? 1
        : 0;
  const statusLabel =
    backendStatus === "completed"
      ? t("changelog.backend.completed")
      : backendStatus === "failed"
        ? t("changelog.backend.failed")
        : installSession?.currentMessage || t("changelog.backend.preparing");

  return (
    <div className="whats-changed-overlay">
      <div className="whats-changed-dialog" role="dialog" aria-modal="true">
        <header className="whats-changed-header">
          <div>
            <p className="whats-changed-kicker">
              {t("changelog.versionRange", {
                from: changelog.fromVersion,
                to: changelog.toVersion
              })}
            </p>
            <h2>{changelog.title || t("changelog.title")}</h2>
          </div>
          <div className={`whats-changed-source whats-changed-source-${changelog.source ?? "loading"}`}>
            {changelog.source === "remote"
              ? t("changelog.source.remote")
              : changelog.source === "bundled"
                ? t("changelog.source.bundled")
                : t("changelog.source.loading")}
          </div>
        </header>

        <section className="whats-changed-progress" aria-live="polite">
          <div className="whats-changed-progress-top">
            <span>{t("changelog.backend.title")}</span>
            <span>{formatPercent(progress)}</span>
          </div>
          <div className={`whats-changed-progress-bar ${backendStatus === "running" || backendStatus === "pending" ? "is-running" : ""}`}>
            <div
              className="whats-changed-progress-fill"
              style={{ width: `${Math.max(backendStatus === "pending" ? 8 : 0, Math.round(progress * 100))}%` }}
            />
          </div>
          <p>{statusLabel}</p>
        </section>

        <section className="whats-changed-body">
          {changelog.status === "loading" ? (
            <div className="whats-changed-loading">
              {t("changelog.loading")}
            </div>
          ) : (
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              rehypePlugins={[rehypeSanitize]}
              components={{
                a: ({ href, children }) => (
                  <a
                    href={href}
                    onClick={(event) => {
                      event.preventDefault();
                      if (href && /^https?:\/\//i.test(href)) {
                        void window.ipcRenderer.invoke("open-external", href);
                      }
                    }}
                  >
                    {children}
                  </a>
                ),
                img: ({ src, alt }) => (
                  <img
                    src={resolveAssetUrl(src, changelog.assetBaseUrl)}
                    alt={alt || t("changelog.imageAlt")}
                    loading="lazy"
                  />
                )
              }}
            >
              {changelog.markdown || t("changelog.empty")}
            </ReactMarkdown>
          )}
        </section>

        {changelog.error ? (
          <p className="whats-changed-note">{t("changelog.fallbackNote")}</p>
        ) : null}

        <footer className="whats-changed-footer">
          {isFailed ? (
            <>
              <button className="install-btn-retry" onClick={onRetry}>
                {t("install.retry")}
              </button>
              <button className="install-btn-logs" onClick={onOpenLogs}>
                {t("install.openLogs")}
              </button>
              <button className="install-btn-quit" onClick={onQuit}>
                {t("install.quit")}
              </button>
            </>
          ) : (
            <button
              className="whats-changed-continue"
              onClick={onContinue}
              disabled={!canContinue}
            >
              {canContinue ? t("changelog.continue") : t("changelog.syncing")}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
