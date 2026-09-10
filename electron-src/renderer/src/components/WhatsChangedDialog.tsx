import { useCallback, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
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

function isVideoAsset(src: string | undefined): boolean {
    return /\.(?:mp4|webm)(?:[?#]|$)/i.test(src ?? "");
}

const CHANGELOG_REMARK_PLUGINS = [remarkGfm];
const CHANGELOG_REHYPE_PLUGINS = [rehypeSanitize];

function getYouTubeEmbedUrl(href: string | undefined): string | null {
  if (!href) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") {
    return null;
  }

  const hostname = url.hostname.toLowerCase();
  let videoId: string | null = null;
  if (hostname === "youtu.be") {
    videoId = url.pathname.split("/").filter(Boolean)[0] ?? null;
  } else if (
    hostname === "youtube.com" ||
    hostname === "www.youtube.com" ||
    hostname === "m.youtube.com"
  ) {
    videoId = url.pathname === "/watch" ? url.searchParams.get("v") : null;
  }

  if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
    return null;
  }

  const embedUrl = new URL(`https://www.youtube-nocookie.com/embed/${videoId}`);
  embedUrl.searchParams.set("origin", "https://github.com");
  embedUrl.searchParams.set(
    "widget_referrer",
    "https://github.com/bpwhelan/GameSentenceMiner/"
  );
  return embedUrl.toString();
}

type ChangelogSettingAction = {
  setting: string;
  choice: "enable" | "disable";
};

function parseChangelogSettingAction(href: string | undefined): ChangelogSettingAction | null {
  const match = /^https:\/\/gsm-setting\.invalid\/([a-z0-9-]+)\/(enable|disable)$/i.exec(href ?? "");
  if (!match) {
    return null;
  }
  return {
    setting: match[1].toLowerCase(),
    choice: match[2].toLowerCase() as ChangelogSettingAction["choice"],
  };
}

export function WhatsChangedDialog({
  changelog,
  installSession,
  backendStatus,
  requiresBackendSync = true,
  onContinue,
  onRetry,
  onOpenLogs,
  onQuit
}: {
  changelog: DesktopUpdateChangelogSnapshot;
  installSession: InstallSessionSnapshot | null;
  backendStatus: "pending" | "running" | "completed" | "failed";
  requiresBackendSync?: boolean;
  onContinue: () => void;
  onRetry: () => void;
  onOpenLogs: () => void;
  onQuit: () => void;
}) {
  const t = useTranslation();
  const [appliedSettingChoices, setAppliedSettingChoices] = useState<Record<string, string>>({});
  const [pendingSetting, setPendingSetting] = useState<string | null>(null);
  const [settingChoiceError, setSettingChoiceError] = useState(false);
  const isFailed = requiresBackendSync && backendStatus === "failed";
  const canContinue = !requiresBackendSync || backendStatus === "completed";
  const canApplySettingChoices = !requiresBackendSync || backendStatus === "completed";
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

  const applySettingChoice = useCallback(async (action: ChangelogSettingAction) => {
    setPendingSetting(action.setting);
    setSettingChoiceError(false);
    try {
      const response = await window.ipcRenderer.invoke<{ success?: boolean }>(
        "changelog.applySettingChoice",
        `${action.setting}:${action.choice}`
      );
      if (response?.success) {
        setAppliedSettingChoices((previous) => ({
          ...previous,
          [action.setting]: action.choice,
        }));
      } else {
        setSettingChoiceError(true);
      }
    } catch {
      setSettingChoiceError(true);
    } finally {
      setPendingSetting(null);
    }
  }, []);

  const settingEnabledLabel = t("changelog.settingChoice.enabled");
  const settingDisabledLabel = t("changelog.settingChoice.disabled");
  const youtubeVideoLabel = t("changelog.youtubeVideo");
  const imageAltLabel = t("changelog.imageAlt");

  // Install progress updates rerender this dialog frequently. Keep the Markdown
  // renderer component identities stable so embedded iframes are not remounted.
  const markdownComponents = useMemo<Components>(
    () => ({
      a: ({ href, children }) => (
        (() => {
          const action = parseChangelogSettingAction(href);
          if (action) {
            const selectedChoice = appliedSettingChoices[action.setting];
            if (selectedChoice === action.choice) {
              return (
                <span
                  className="changelog-setting-choice-result"
                  data-changelog-setting={action.setting}
                >
                  {action.choice === "enable" ? settingEnabledLabel : settingDisabledLabel}
                </span>
              );
            }
            return (
              <button
                type="button"
                className="changelog-setting-choice"
                data-changelog-setting={action.setting}
                onClick={() => void applySettingChoice(action)}
                disabled={!canApplySettingChoices || pendingSetting === action.setting}
              >
                {children}
              </button>
            );
          }

          const youtubeEmbedUrl = getYouTubeEmbedUrl(href);
          if (youtubeEmbedUrl) {
            return (
              <span className="changelog-youtube-embed">
                <iframe
                  src={youtubeEmbedUrl}
                  title={youtubeVideoLabel}
                  loading="lazy"
                  referrerPolicy="strict-origin-when-cross-origin"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                  allowFullScreen
                />
                <a
                  className="changelog-youtube-link"
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
              </span>
            );
          }

          return (
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
          );
        })()
      ),
      img: ({ src, alt }) => {
        const resolvedSrc = resolveAssetUrl(src, changelog.assetBaseUrl);
        return isVideoAsset(src) ? (
          <video
            src={resolvedSrc}
            aria-label={alt || undefined}
            controls
            preload="metadata"
          />
        ) : (
          <img
            src={resolvedSrc}
            alt={alt || imageAltLabel}
            loading="lazy"
          />
        );
      }
    }),
    [
      appliedSettingChoices,
      applySettingChoice,
      canApplySettingChoices,
      changelog.assetBaseUrl,
      imageAltLabel,
      pendingSetting,
      settingDisabledLabel,
      settingEnabledLabel,
      youtubeVideoLabel
    ]
  );

  return (
    <div className="whats-changed-overlay">
      <div className="whats-changed-dialog" role="dialog" aria-modal="true">
        <header className="whats-changed-header">
          <div>
            <p className="whats-changed-kicker">
              {changelog.fromVersion === changelog.toVersion
                ? changelog.toVersion
                : t("changelog.versionRange", {
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

        {requiresBackendSync ? (
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
        ) : null}

        <section className="whats-changed-body">
          {changelog.status === "loading" ? (
            <div className="whats-changed-loading">
              {t("changelog.loading")}
            </div>
          ) : (
            <ReactMarkdown
              remarkPlugins={CHANGELOG_REMARK_PLUGINS}
              rehypePlugins={CHANGELOG_REHYPE_PLUGINS}
              components={markdownComponents}
            >
              {changelog.markdown || t("changelog.empty")}
            </ReactMarkdown>
          )}
        </section>

        {changelog.error || settingChoiceError ? (
          <p className={`whats-changed-note${settingChoiceError ? " changelog-setting-choice-error" : ""}`}>
            {changelog.error ? t("changelog.fallbackNote") : null}
            {changelog.error && settingChoiceError ? " " : null}
            {settingChoiceError ? t("changelog.settingChoice.error") : null}
          </p>
        ) : null}

        <footer className="whats-changed-footer">
          {isFailed ? (
            <>
              <button type="button" className="install-btn-retry" onClick={onRetry}>
                {t("install.retry")}
              </button>
              <button type="button" className="install-btn-logs secondary" onClick={onOpenLogs}>
                {t("install.openLogs")}
              </button>
              <button type="button" className="install-btn-quit danger" onClick={onQuit}>
                {t("install.quit")}
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`whats-changed-continue${requiresBackendSync ? "" : " secondary"}`}
              onClick={onContinue}
              disabled={requiresBackendSync && !canContinue}
            >
              {requiresBackendSync
                ? canContinue
                  ? t("changelog.continue")
                  : t("changelog.syncing")
                : t("changelog.close")}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
