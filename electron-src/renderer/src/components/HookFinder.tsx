import { useEffect, useMemo } from "react";
import {
  assessHookQuality, createHookRanker, type HookCandidate, type HookQuality, type HookQualityReason,
} from "../../../shared/texthook_quality";
import { useTranslation } from "../i18n";
import { invokeIpc, onIpc } from "../lib/ipc";
import { PROCESSOR_META } from "../lib/textProcessorMetadata";
import { useBufferedState } from "../lib/useBufferedState";
import "./HookFinder.css";

export type ProcessorOverrides = Record<string, boolean | "blocks" | "trim" | "strict">;

type MatchTier = "exact" | "fuzzy" | "filtered" | "close" | "unmatched";
type HookMatch = {
  hookId: string;
  tier: MatchTier;
  sample?: string;
  output?: string;
  ocrText?: string;
  changes?: ProcessorOverrides;
  processorOverrides: ProcessorOverrides;
};

type DiscoveryResult = { status: "ok"; sessionId: string; sceneId: string; matches: HookMatch[] };
type DiscoverySnapshot = DiscoveryResult | {
  status: "scanning" | "noScene" | "noText" | "stale" | "error";
  sessionId: string;
  sceneId?: string;
};

const HOOK_QUALITY_LABEL_KEYS: Record<HookQualityReason, string> = {
  targetLanguage: "texthook.hooks.quality.targetLanguage",
  possibleLanguage: "texthook.hooks.quality.possibleLanguage",
  readable: "texthook.hooks.quality.readable",
  mixed: "texthook.hooks.quality.mixed",
  paths: "texthook.hooks.quality.paths",
  garbled: "texthook.hooks.quality.garbled",
  repetitive: "texthook.hooks.quality.repetitive",
  symbols: "texthook.hooks.quality.symbols",
  noText: "texthook.hooks.noTextYet",
};

export type HookFinderSelection = { sessionId: string; sceneId: string; processorOverrides: ProcessorOverrides };

export function useHookFinder(enabled: boolean, sessionId?: string, sceneId?: string) {
  const [latest, setLatest] = useBufferedState<DiscoverySnapshot | null>(null, enabled);
  useEffect(() => {
    if (!enabled || !sessionId) return;
    let cancelled = false;
    let receivedUpdate = false;
    const off = onIpc("texthook.recommendations", (_event, payload) => {
      const snapshot = payload as DiscoverySnapshot | null;
      if (!cancelled && snapshot?.sessionId === sessionId) {
        receivedUpdate = true;
        setLatest(snapshot);
      }
    });
    void invokeIpc<DiscoverySnapshot | null>("texthook.getRecommendations").then((snapshot) => {
      if (!cancelled && !receivedUpdate) {
        setLatest(snapshot?.sessionId === sessionId ? snapshot : null);
      }
    }).catch(() => {});
    return () => {
      cancelled = true;
      off();
    };
  }, [enabled, sessionId, setLatest]);

  const current = enabled && latest?.sessionId === sessionId
    && (!sceneId || !latest?.sceneId || latest.sceneId === sceneId) ? latest : null;
  return { enabled, status: current?.status, result: current?.status === "ok" ? current : undefined };
}

interface HookRankingOptions {
  targetLanguage: string;
  selectedHookId: string | null;
  showLikelyNoise: boolean;
  discovery?: DiscoveryResult;
}

function recommendHookQuality(quality: HookQuality, match: HookMatch | null, targetLanguage: string) {
  // Real dialogue recovered from a strong match should receive the same quality
  // check as raw text, even if the original capture had control codes or markup.
  if (quality.score >= 3 || !match?.output || match.output === match.sample ||
      match.tier === "unmatched" || match.tier === "close") return quality;
  const cleaned = assessHookQuality({ preview: match.output, samples: [] }, targetLanguage);
  return cleaned.score >= 2 && cleaned.score > quality.score ? cleaned : quality;
}

export function useRankedHookList<T extends HookCandidate>(hooks: readonly T[], {
  targetLanguage, selectedHookId, showLikelyNoise, discovery,
}: HookRankingOptions) {
  const rankHookCandidates = useMemo(createHookRanker, []);
  const candidates = useMemo(() => rankHookCandidates(hooks, targetLanguage, selectedHookId)
    .filter(({ hook, quality }) => hook.id === selectedHookId || quality.hasText),
  [hooks, rankHookCandidates, selectedHookId, targetLanguage]);

  const ranked = useMemo(() => {
    if (!discovery) return candidates.map((entry) => ({ ...entry, match: null }));
    const unmatchedRank = discovery.matches.length;
    const rankedMatches = new Map(discovery.matches.map((match, index) => [
      match.hookId, { match, ocrRank: match.tier === "unmatched" ? unmatchedRank : index },
    ]));
    return candidates.map(({ hook, index, quality }) => {
      const recommendation = rankedMatches.get(hook.id);
      const match = recommendation?.match ?? null;
      return {
        hook, index, match, quality: recommendHookQuality(quality, match, targetLanguage),
        ocrRank: recommendation?.ocrRank ?? unmatchedRank,
      };
    }).sort((a, b) =>
      Number(b.hook.id === selectedHookId) - Number(a.hook.id === selectedHookId)
      || Number(a.quality.likelyNoise) - Number(b.quality.likelyNoise)
      || Number(b.quality.score >= 3) - Number(a.quality.score >= 3)
      || a.ocrRank - b.ocrRank
      || b.quality.score - a.quality.score
      || a.index - b.index);
  }, [candidates, discovery, selectedHookId, targetLanguage]);

  const isHiddenNoise = ({ hook, quality }: (typeof ranked)[number]) => quality.likelyNoise && hook.id !== selectedHookId;
  return {
    visibleHooks: showLikelyNoise ? ranked : ranked.filter((entry) => !isHiddenNoise(entry)),
    likelyNoiseCount: ranked.filter(isHiddenNoise).length,
  };
}

export function selectTextHook(hookId: string, selection?: HookFinderSelection) {
  return invokeIpc<{ success: boolean; processorOverrides?: ProcessorOverrides | null }>(
    "texthook.selectHook", hookId, ...(selection ? [selection] : []),
  );
}

export function HookFinderStatus({ finder, hooks, selectedHookId }: {
  finder: ReturnType<typeof useHookFinder>;
  hooks: readonly { match: HookMatch | null }[];
  selectedHookId: string | null;
}) {
  const t = useTranslation();
  if (!finder.enabled || (!selectedHookId && finder.result && hooks.length === 0)) return null;
  const message = selectedHookId ? "selected" : finder.result
    ? hooks.some(({ match }) => match && match.tier !== "unmatched") ? "ranked" : "noMatch"
    : finder.status ?? "waiting";
  return <p className="hook-finder-status" role="status">{t(`texthook.finder.${message}`)}</p>;
}

export function HookQualityLabel({ quality }: { quality: HookQuality | null }) {
  const t = useTranslation();
  if (!quality?.hasText) return null;
  const label = t(HOOK_QUALITY_LABEL_KEYS[quality.reason]);
  return (
    <span className={`texthook-hook-quality ${quality.score >= 3 ? "texthook-hook-quality--match" : ""}`} title={label}>
      {label}
    </span>
  );
}

export function HookNoiseToggle({ id, count, targetLanguage, checked, onChange }: {
  id: string;
  count: number;
  targetLanguage: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const t = useTranslation();
  return (
    <label
      className="texthook-noise-toggle"
      htmlFor={id}
      data-tip={targetLanguage
        ? t("texthook.hooks.rankingHint", { language: targetLanguage.toUpperCase() })
        : t("texthook.hooks.readabilityHint")}
    >
      <input id={id} type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} />
      {t("texthook.hooks.showNoise", { count })}
    </label>
  );
}

export function HookMatchDetails({ match }: { match: HookMatch | null }) {
  const t = useTranslation();
  if (!match || match.tier === "unmatched") return null;
  const { tier, changes } = match;
  const mode = changes?.language_filter_mode;
  return (
    <span className="hook-match-details">
      <span className={`hook-match-tier hook-match-tier--${tier}`}>{t(`texthook.finder.tiers.${tier}`)}</span>
      {match.ocrText ? (
        <span className="hook-match-evidence" title={match.ocrText}>
          {t("texthook.finder.onScreen", { text: match.ocrText })}
        </span>
      ) : null}
      {changes && PROCESSOR_META.filter(({ id }) => changes[id] === true).map(({ id, labelKey }) => (
        <span key={id} className="hook-match-filter">
          {t("texthook.finder.enable", { filter: t(labelKey) })}
        </span>
      ))}
      {typeof mode === "string" ? (
        <span className="hook-match-filter">{t(`texthook.finder.languageMode.${mode}`)}</span>
      ) : null}
    </span>
  );
}
