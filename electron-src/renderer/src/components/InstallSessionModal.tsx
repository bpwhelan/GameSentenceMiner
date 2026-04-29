import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "../i18n";

import type {
  InstallProgressKind,
  InstallSessionSnapshot,
  InstallStageState,
  InstallStageStatus
} from "../../../shared/install_session";

type DisplayStageId =
  | "python_setup"
  | "gsm_backend"
  | "obs"
  | "ffmpeg"
  | "oneocr"
  | "finalize";

interface DisplayStage {
  id: DisplayStageId;
  label: string;
  status: InstallStageStatus;
  progressKind: InstallProgressKind;
  progress: number | null;
  message: string;
  error: string | null;
  downloadedBytes: number | null;
  totalBytes: number | null;
}

const DISPLAY_STAGE_GROUPS: Array<{
  id: DisplayStageId;
  labelKey: string;
  stageIds: InstallStageState["id"][];
}> = [
  {
    id: "python_setup",
    labelKey: "install.stages.pythonSetup",
    stageIds: ["prepare", "uv", "python", "venv", "verify_runtime"]
  },
  {
    id: "gsm_backend",
    labelKey: "install.stages.gsmBackend",
    stageIds: ["lock_sync", "gsm_package", "backend_boot"]
  },
  {
    id: "obs",
    labelKey: "install.stages.obs",
    stageIds: ["obs"]
  },
  {
    id: "ffmpeg",
    labelKey: "install.stages.ffmpeg",
    stageIds: ["ffmpeg"]
  },
  {
    id: "oneocr",
    labelKey: "install.stages.oneocr",
    stageIds: ["oneocr"]
  },
  {
    id: "finalize",
    labelKey: "install.stages.finalize",
    stageIds: ["finalize"]
  }
];

function formatPercent(progress: number): string {
  return `${Math.round(progress * 100)}%`;
}

function formatBytes(value: number | null): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "";
  }
  const units = ["B", "KB", "MB", "GB"];
  let remaining = value;
  let unitIndex = 0;
  while (remaining >= 1024 && unitIndex < units.length - 1) {
    remaining /= 1024;
    unitIndex += 1;
  }
  return `${remaining.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDuration(startedAt: number, finishedAt: number | null): string {
  const elapsedMs = Math.max(0, (finishedAt ?? Date.now()) - startedAt);
  const totalSeconds = Math.floor(elapsedMs / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function getStageMeta(
  stage: Pick<InstallStageState, "status" | "progressKind" | "message" | "error">
): { labelKey: string; detail: string; detailKey?: string } {
  if (stage.status === "completed") {
    return { labelKey: "install.status.done", detail: stage.message || "", detailKey: stage.message ? undefined : "install.status.completed" };
  }
  if (stage.status === "skipped") {
    return { labelKey: "install.status.skipped", detail: stage.message || "", detailKey: stage.message ? undefined : "install.status.skippedDetail" };
  }
  if (stage.status === "failed") {
    return { labelKey: "install.status.failed", detail: stage.error || stage.message || "", detailKey: (stage.error || stage.message) ? undefined : "install.status.failedDetail" };
  }
  if (stage.status === "running") {
    return {
      labelKey: stage.progressKind === "bytes" ? "install.status.downloading" : "install.status.working",
      detail: stage.message || "",
      detailKey: stage.message ? undefined : "install.status.workingDetail"
    };
  }
  return { labelKey: "install.status.pending", detail: stage.message || "", detailKey: stage.message ? undefined : "install.status.waiting" };
}

function getStageRatio(stage: InstallStageState): number {
  if (stage.status === "completed" || stage.status === "skipped") {
    return 1;
  }
  if (typeof stage.progress === "number") {
    return Math.max(0, Math.min(1, stage.progress));
  }
  return 0;
}

function getBarWidth(stage: DisplayStage): string {
  if (typeof stage.progress === "number") {
    return `${Math.max(6, Math.round(stage.progress * 100))}%`;
  }
  return "34%";
}

function buildDisplayStage(
  id: DisplayStageId,
  label: string,
  stages: InstallStageState[]
): DisplayStage {
  const latestProblem = [...stages].reverse().find((s) => s.status === "failed");
  const latestRunning = [...stages].reverse().find((s) => s.status === "running");
  const latestMeaningful = [...stages].reverse().find((s) => s.error || s.message);

  const allPending = stages.every((s) => s.status === "pending");
  const allSkipped = stages.every((s) => s.status === "skipped");
  const allDone = stages.every((s) => s.status === "completed" || s.status === "skipped");
  const hasStarted = stages.some((s) => s.status !== "pending");

  let status: InstallStageStatus = "pending";
  if (latestProblem) status = "failed";
  else if (latestRunning) status = "running";
  else if (allPending) status = "pending";
  else if (allSkipped) status = "skipped";
  else if (allDone) status = "completed";
  else if (hasStarted) status = "running";

  const totalWeight = stages.reduce((sum, s) => sum + s.weight, 0);
  const weightedProgress =
    totalWeight > 0
      ? stages.reduce((sum, s) => sum + s.weight * getStageRatio(s), 0) / totalWeight
      : 0;

  const active = latestProblem ?? latestRunning ?? latestMeaningful ?? stages[stages.length - 1];

  return {
    id,
    label,
    status,
    progressKind: active?.progressKind ?? "indeterminate",
    progress:
      status === "completed" || status === "skipped"
        ? 1
        : weightedProgress > 0
          ? weightedProgress
          : active?.progress ?? null,
    message:
      active?.error ||
      active?.message ||
      (status === "running" ? "Working..." : status === "pending" ? "Waiting..." : ""),
    error: latestProblem?.error ?? null,
    downloadedBytes: active?.downloadedBytes ?? null,
    totalBytes: active?.totalBytes ?? null
  };
}

function ActivityDots() {
  return (
    <span className="install-session-activity" aria-hidden="true">
      <span />
      <span />
      <span />
    </span>
  );
}

export function InstallSessionModal({
  snapshot,
  onRetry,
  onOpenLogs,
  onQuit
}: {
  snapshot: InstallSessionSnapshot;
  onRetry: () => void;
  onOpenLogs: () => void;
  onQuit: () => void;
}) {
  const t = useTranslation();
  const logListRef = useRef<HTMLDivElement | null>(null);
  const stickToBottomRef = useRef(true);
  const [logsExpanded, setLogsExpanded] = useState(false);

  const displayStages = useMemo(() => {
    return DISPLAY_STAGE_GROUPS.map((group) => {
      const stages = group.stageIds
        .map((id) => snapshot.stages.find((s) => s.id === id))
        .filter((s): s is InstallStageState => Boolean(s));
      return buildDisplayStage(group.id, group.labelKey, stages);
    });
  }, [snapshot.stages]);

  const currentDisplayStageId = useMemo(() => {
    const group = DISPLAY_STAGE_GROUPS.find((g) =>
      snapshot.currentStageId ? g.stageIds.includes(snapshot.currentStageId) : false
    );
    if (group) return group.id;
    return (
      displayStages.find((s) => s.status === "failed")?.id ??
      displayStages.find((s) => s.status === "running")?.id ??
      displayStages[displayStages.length - 1]?.id
    );
  }, [displayStages, snapshot.currentStageId]);

  const currentStage =
    displayStages.find((s) => s.id === currentDisplayStageId) ??
    displayStages[displayStages.length - 1];

  const completedCount = displayStages.filter(
    (s) => s.status === "completed" || s.status === "skipped"
  ).length;

  const bytesLabel =
    currentStage && typeof currentStage.downloadedBytes === "number"
      ? `${formatBytes(currentStage.downloadedBytes)}${
          typeof currentStage.totalBytes === "number"
            ? ` / ${formatBytes(currentStage.totalBytes)}`
            : ""
        }`
      : "";

  const showCurrentBar =
    currentStage &&
    (currentStage.status === "running" || typeof currentStage.progress === "number");

  useEffect(() => {
    const node = logListRef.current;
    if (node && stickToBottomRef.current) {
      node.scrollTop = node.scrollHeight;
    }
  }, [snapshot.logs.length]);

  return (
    <div className="install-session-overlay">
      <div className="install-session-modal">
        {/* Header */}
        <div className="install-session-header">
          <div className="install-session-title-block">
            <h2>{t("install.title")}</h2>
            <p>{snapshot.currentMessage || t("install.preparing")}</p>
          </div>
          <div className="install-session-timing">
            <span>{formatPercent(snapshot.overallProgress)}</span>
            <span>{formatDuration(snapshot.startedAt, snapshot.finishedAt)}</span>
            <span>
              {t("install.steps", { completed: String(completedCount), total: String(displayStages.length) })}
            </span>
          </div>
        </div>

        {/* Overall progress */}
        <div className="install-session-progress-wrap">
          <div
            className={`install-session-progress ${
              snapshot.status === "running" ? "is-running" : ""
            }`}
          >
            <div
              className="install-session-progress-fill"
              style={{ width: `${Math.round(snapshot.overallProgress * 100)}%` }}
            />
          </div>
        </div>

        {/* Body */}
        <div className="install-session-body">
          {/* Current stage detail */}
          <div
            className={`install-session-current ${
              currentStage?.status === "running" ? "is-running" : ""
            }`}
          >
            <div className="install-session-current-top">
              <div className="install-session-current-copy">
                <div className="install-session-current-title-row">
                  <div className="install-session-current-title">
                    {currentStage ? t(currentStage.label) : t("install.preparing")}
                  </div>
                  {currentStage?.status === "running" ? <ActivityDots /> : null}
                </div>
                <div className="install-session-current-detail">
                  {currentStage?.message || snapshot.currentMessage}
                </div>
              </div>
              <div className="install-session-current-meta">
                {bytesLabel ? (
                  <span className="install-session-current-chip">{bytesLabel}</span>
                ) : null}
                {typeof currentStage?.progress === "number" ? (
                  <span className="install-session-current-chip strong">
                    {formatPercent(currentStage.progress)}
                  </span>
                ) : null}
              </div>
            </div>
            {showCurrentBar ? (
              <div
                className={`install-session-stage-progress ${
                  currentStage.status === "running" ? "is-running" : ""
                }`}
              >
                <div
                  className={`install-session-stage-progress-fill ${
                    currentStage.status === "running" &&
                    typeof currentStage.progress !== "number"
                      ? "is-indeterminate"
                      : ""
                  }`}
                  style={{ width: getBarWidth(currentStage) }}
                />
              </div>
            ) : null}
            {currentStage?.progressKind === "estimated" &&
            currentStage.status === "running" ? (
              <div className="install-session-current-hint">
                {t("install.estimatedProgress")}
              </div>
            ) : null}
          </div>

          {/* Stage list */}
          <div className="install-session-stage-list">
            {displayStages.map((stage) => {
              const meta = getStageMeta(stage);
              const showBar =
                stage.status === "running" || typeof stage.progress === "number";
              return (
                <div
                  key={stage.id}
                  className={`install-session-stage install-session-stage-${stage.status}`}
                >
                  <div className="install-session-stage-heading">
                    <span>{t(stage.label)}</span>
                    <span className="install-session-stage-status">
                      {t(meta.labelKey)}
                      {stage.status === "running" ? <ActivityDots /> : null}
                    </span>
                  </div>
                  <div className="install-session-stage-detail">{meta.detail || t(meta.detailKey ?? "")}</div>
                  {showBar ? (
                    <div
                      className={`install-session-stage-progress ${
                        stage.status === "running" ? "is-running" : ""
                      }`}
                    >
                      <div
                        className={`install-session-stage-progress-fill ${
                          stage.status === "running" &&
                          typeof stage.progress !== "number"
                            ? "is-indeterminate"
                            : ""
                        }`}
                        style={{ width: getBarWidth(stage) }}
                      />
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>

          {/* Logs */}
          <div
            className={`install-session-logs-panel ${
              logsExpanded ? "expanded" : "collapsed"
            }`}
          >
            <button
              type="button"
              className="install-session-logs-header"
              onClick={() => setLogsExpanded((v) => !v)}
              aria-expanded={logsExpanded}
            >
              <span>{t("install.logs")}</span>
              <span className="install-session-logs-header-meta">
                <span>{snapshot.logs.length}</span>
                <span
                  className={`install-session-logs-chevron ${
                    logsExpanded ? "expanded" : ""
                  }`}
                >
                  ▾
                </span>
              </span>
            </button>
            {logsExpanded ? (
              <div
                className="install-session-log-list"
                ref={logListRef}
                onScroll={() => {
                  const node = logListRef.current;
                  if (!node) return;
                  stickToBottomRef.current =
                    node.scrollTop + node.clientHeight >= node.scrollHeight - 24;
                }}
              >
                {snapshot.logs.length === 0 ? (
                  <div className="install-session-log-entry">{t("install.waitingForLogs")}</div>
                ) : (
                  snapshot.logs.map((entry) => (
                    <div key={entry.id} className="install-session-log-entry">
                      {entry.message.trim() || t("install.emptyLog")}
                    </div>
                  ))
                )}
              </div>
            ) : null}
          </div>
        </div>

        {/* Footer — error state only */}
        {snapshot.status === "failed" ? (
          <div className="install-session-footer">
            <button className="install-btn-retry" onClick={onRetry}>
              {t("install.retry")}
            </button>
            <button className="install-btn-logs" onClick={onOpenLogs}>
              {t("install.openLogs")}
            </button>
            <button className="install-btn-quit" onClick={onQuit}>
              {t("install.quit")}
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}
