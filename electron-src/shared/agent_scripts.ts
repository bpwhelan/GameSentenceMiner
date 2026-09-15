export const AGENT_SCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs"] as const;

const AGENT_SCRIPT_EXTENSION_SET = new Set<string>(AGENT_SCRIPT_EXTENSIONS);
const TITLE_ID_PATTERN = /^[0-9a-f]{16}$/i;
const PRODUCT_CODE_PATTERN = /^(?:v\d+|[a-z]{2,}[a-z0-9-]*\d[a-z0-9-]*)$/i;

const PLATFORM_LABELS = new Map<string, string>([
  ["ns", "Switch"],
  ["3ds", "3DS"],
  ["nds", "NDS"],
  ["pc98", "PC-98"],
  ["psp", "PSP"],
  ["ps2", "PS2"],
  ["ps3", "PS3"],
  ["ps4", "PS4"],
  ["psvita", "Vita"],
  ["vita", "Vita"],
  ["pc", "PC"],
  ["android", "Android"],
  ["hcode", "H-Code"],
  ["ios", "iOS"],
]);

const PREFIX_METADATA_LABELS = new Map<string, string>([
  ["japan", "Japan"],
  ["jp", "Japan"],
  ["usa", "USA"],
  ["us", "USA"],
  ["europe", "Europe"],
  ["eu", "Europe"],
  ["en", "English"],
  ["cn", "Chinese"],
  ["tw", "Taiwan"],
  ["kr", "Korea"],
  ["dmm", "DMM"],
  ["steam", "Steam"],
  ["gog", "GOG"],
  ["dlsite", "DLsite"],
  ["unity", "Unity"],
  ["unreal", "Unreal"],
  ["mages", "MAGES"],
  ["kirikiriz", "KiriKiriZ"],
  ["innocentgrey", "InnocentGrey"],
  ["leaf", "Leaf"],
  ["malie", "Malie"],
  ["flash", "Flash"],
  ["javascript", "JavaScript"],
]);

const SUFFIX_METADATA_LABELS = new Map<string, string>([
  ["jp", "Japan"],
  ["japan", "Japan"],
  ["usa", "USA"],
  ["us", "USA"],
  ["en", "English"],
  ["cn", "Chinese"],
  ["tw", "Taiwan"],
  ["kr", "Korea"],
]);

export interface AgentScriptCandidate {
  path: string;
  reason?: string;
  score?: number;
}

export interface AgentScriptDisplayParts {
  title: string;
  metadata: string;
  fileName: string;
  stem: string;
}

export interface AgentScriptSearchContext {
  sceneName?: string | null;
  windowTitle?: string | null;
  processName?: string | null;
}

export interface BuildAgentScriptCandidateListOptions {
  query?: string | null;
  searchContext?: AgentScriptSearchContext;
  scripts?: string[];
  resolvedCandidates?: AgentScriptCandidate[];
  resolvedPath?: string | null;
  resolvedReason?: string;
  resolvedScore?: number;
  limit?: number;
}

function normalizeString(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

export function getAgentScriptFileName(filePath: string): string {
  const normalized = normalizeString(filePath).replace(/\\/g, "/");
  const segments = normalized.split("/");
  return segments[segments.length - 1] || normalized;
}

function getAgentScriptPathParts(filePath: string): string[] {
  return normalizeString(filePath)
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export function getAgentScriptStem(filePath: string): string {
  const fileName = getAgentScriptFileName(filePath);
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex > 0 ? fileName.slice(0, dotIndex) : fileName;
}

export function normalizeAgentScriptPathForCompare(filePath: string): string {
  return normalizeString(filePath).replace(/\\/g, "/").toLowerCase();
}

function getAgentScriptExtension(filePath: string): string {
  const fileName = getAgentScriptFileName(filePath);
  const dotIndex = fileName.lastIndexOf(".");
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : "";
}

export function isListableAgentScriptPath(filePath: string): boolean {
  const fileName = getAgentScriptFileName(filePath);
  const lowerFileName = fileName.toLowerCase();
  return (
    AGENT_SCRIPT_EXTENSION_SET.has(getAgentScriptExtension(fileName)) &&
    !lowerFileName.startsWith("_") &&
    !lowerFileName.startsWith("lib")
  );
}

export function isNintendoSwitchAgentScriptPath(filePath: string): boolean {
  return /^NS_/i.test(getAgentScriptFileName(filePath));
}

function tokenize(value: string): string[] {
  return normalizeSearchText(value)
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactSearchText(value: string): string {
  return normalizeSearchText(value).replace(/\s+/g, "");
}

function prettifyScriptText(value: string): string {
  return value
    .replace(/_/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function pushUniqueMetadata(metadata: string[], label: string) {
  if (!metadata.includes(label)) {
    metadata.push(label);
  }
}

function formatProductCodeMetadata(value: string): string {
  return /^v\d+$/i.test(value) ? value : value.toUpperCase();
}

export function formatAgentScriptDisplay(filePath: string): AgentScriptDisplayParts {
  const fileName = getAgentScriptFileName(filePath);
  const stem = getAgentScriptStem(filePath);
  const segments = stem.split("_").filter((segment) => segment.trim().length > 0);
  const metadata: string[] = [];
  let titleSegments = segments;

  const pathParts = getAgentScriptPathParts(filePath);
  const parentDirectory = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : "";
  const parentPlatformLabel = PLATFORM_LABELS.get(parentDirectory.toLowerCase());
  if (parentPlatformLabel) {
    pushUniqueMetadata(metadata, parentPlatformLabel);
  }

  const platformLabel = PLATFORM_LABELS.get((titleSegments[0] ?? "").toLowerCase());
  if (platformLabel) {
    pushUniqueMetadata(metadata, platformLabel);
    titleSegments = titleSegments.slice(1);
  }

  if (titleSegments[0] && TITLE_ID_PATTERN.test(titleSegments[0])) {
    pushUniqueMetadata(metadata, titleSegments[0].toUpperCase());
    titleSegments = titleSegments.slice(1);
  } else if (titleSegments[0] && PRODUCT_CODE_PATTERN.test(titleSegments[0])) {
    pushUniqueMetadata(metadata, formatProductCodeMetadata(titleSegments[0]));
    titleSegments = titleSegments.slice(1);
  }

  while (titleSegments.length > 1) {
    const prefixLabel = PREFIX_METADATA_LABELS.get(titleSegments[0].toLowerCase());
    if (!prefixLabel) {
      break;
    }
    pushUniqueMetadata(metadata, prefixLabel);
    titleSegments = titleSegments.slice(1);
  }

  while (titleSegments.length > 1) {
    const suffixLabel = SUFFIX_METADATA_LABELS.get(
      titleSegments[titleSegments.length - 1].toLowerCase()
    );
    if (!suffixLabel) {
      break;
    }
    pushUniqueMetadata(metadata, suffixLabel);
    titleSegments = titleSegments.slice(0, -1);
  }

  const title = prettifyScriptText(
    titleSegments.length > 0 ? titleSegments.join("_") : stem
  );

  return {
    title: title || fileName || filePath,
    metadata: metadata.join(" | "),
    fileName,
    stem,
  };
}

export function normalizeAgentScriptCandidateScore(score: unknown): number | null {
  if (typeof score !== "number" || !Number.isFinite(score)) {
    return null;
  }
  return Math.max(0, Math.min(1, score));
}

const CONTEXT_STOP_WORDS = new Set([
  "the", "and", "for", "with", "game", "title", "scene", "capture", "window",
  "main", "launcher", "loading", "release", "debug", "build", "shipping", "client",
  "win32", "win64", "x32", "x64", "x86", "windows", "bit", "fps", "version",
  "vulkan", "opengl", "directx", "msvc", "nintendo", "switch",
  "yuzu", "suyu", "ryujinx", "eden", "citron", "sudachi", "torzu",
  "citra", "ppsspp", "rpcs3", "pcsx2", "retroarch", "desmume", "melonDS",
  "unity", "unityplayer", "unreal", "ue4game", "ue5game", "nw", "node", "java",
  "python", "pythonw", "krkr", "krkrz", "kirikiri", "tvp",
].map((word) => word.toLowerCase()));

function normalizeContextHint(value: string): string {
  return normalizeSearchText(
    value.normalize("NFKC")
      .replace(/\b[0-9a-f]{16}\b/gi, " ")
      .replace(/\b(?:v\d+(?:\.\d+)+|\d+\s*(?:fps|bit))\b/gi, " ")
  ).split(" ")
    .filter((token) => token && !CONTEXT_STOP_WORDS.has(token))
    .join(" ");
}

function getContextHintGroups(context: AgentScriptSearchContext): string[][] {
  const executable = getAgentScriptFileName(normalizeString(context.processName).replace(/^"|"$/g, ""))
    .replace(/\.(?:exe|bin|app)$/i, "");
  const groups = [
    [normalizeString(context.sceneName)],
    [normalizeString(context.windowTitle), ...normalizeString(context.windowTitle).split("|")],
    [executable],
  ];
  const seen = new Set<string>();
  return groups.map((group) => {
    const hints = Array.from(new Set(group.map(normalizeContextHint)))
      .filter((hint) => hint.length >= 3 && /\p{L}/u.test(hint));
    // Repeated scene/title/executable names are one signal, not extra evidence.
    return hints.filter((hint) => {
      const key = compactSearchText(hint);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }).filter((group) => group.length > 0);
}

export function getAgentScriptSearchQueries(context: AgentScriptSearchContext): string[] {
  return getContextHintGroups(context).flat();
}

function scoreContextHint(query: string, title: string): number {
  const compactQuery = compactSearchText(query);
  const compactTitle = compactSearchText(title);
  if (!compactTitle || compactTitle.length < 3) return 1;
  if (compactQuery === compactTitle) return 0.04;

  const queryTokens = query.split(" ");
  const titleTokens = title.split(" ");
  const queryNumbers = queryTokens.filter((token) => /^\d+$/.test(token));
  const titleNumbers = titleTokens.filter((token) => /^\d+$/.test(token));
  const conflictingNumber = queryNumbers.length > 0 && titleNumbers.length > 0 &&
    !titleNumbers.every((number) => queryNumbers.includes(number));
  if (!conflictingNumber && compactTitle.length >= 4 && compactQuery.includes(compactTitle)) {
    return 0.2;
  }
  // A shortened name may identify a series, but cannot identify its game/version.
  if (compactQuery.length >= 4 && compactTitle.includes(compactQuery)) return 0.3;

  const matched = titleTokens.filter((token) => queryTokens.includes(token)).length;
  if (matched === 0) return 1;
  const coverage = Math.min(matched / titleTokens.length, matched / queryTokens.length);
  return Math.max(0.2, 1 - coverage * 0.8);
}

export function scoreAgentScriptForContext(
  context: AgentScriptSearchContext,
  scriptPath: string
): number {
  const title = normalizeContextHint(formatAgentScriptDisplay(scriptPath).title);
  const scores = getContextHintGroups(context)
    .map((hints) => Math.min(...hints.map((hint) => scoreContextHint(hint, title))))
    .sort((left, right) => left - right);
  const best = scores[0] ?? 1;
  if (best === 1) return 1;
  const corroborating = scores.slice(1).filter((score) => score < 0.65).length;
  // Agreement improves ordering without turning several weak hints into a recommendation.
  return Math.max(best <= 0.15 ? 0.005 : 0.2, best - corroborating * 0.02);
}

export function scoreAgentScriptForQuery(query: string, scriptPath: string): number {
  const rawQuery = normalizeString(query).normalize("NFKC").toLowerCase();
  if (!rawQuery) {
    return 0;
  }
  const normalizedPathQuery = rawQuery.replace(/\\/g, "/");

  const display = formatAgentScriptDisplay(scriptPath);
  const normalizedPath = normalizeAgentScriptPathForCompare(scriptPath);
  const normalizedFileName = display.fileName.toLowerCase();
  const normalizedQuery = normalizeSearchText(rawQuery);
  const normalizedTitle = normalizeSearchText(display.title);
  const normalizedFileNameText = normalizeSearchText(display.fileName);
  const compactQuery = compactSearchText(rawQuery);
  const compactTitle = compactSearchText(display.title);
  const compactFileName = compactSearchText(display.fileName);

  if (
    normalizedPath === normalizedPathQuery ||
    normalizedFileName === rawQuery ||
    normalizedTitle === normalizedQuery
  ) {
    return 0;
  }

  if (
    normalizedQuery &&
    (normalizedTitle.includes(normalizedQuery) || normalizedQuery.includes(normalizedTitle))
  ) {
    return 0.05;
  }
  if (
    compactQuery &&
    (compactTitle.includes(compactQuery) || compactQuery.includes(compactTitle))
  ) {
    return 0.06;
  }
  if (
    normalizedQuery &&
    (normalizedFileNameText.includes(normalizedQuery) ||
      normalizedQuery.includes(normalizedFileNameText))
  ) {
    return 0.1;
  }
  if (
    compactQuery &&
    (compactFileName.includes(compactQuery) || compactQuery.includes(compactFileName))
  ) {
    return 0.12;
  }
  if (normalizedPath.includes(normalizedPathQuery)) {
    return 0.2;
  }

  const queryTokens = Array.from(new Set(tokenize(normalizedQuery)));
  if (queryTokens.length === 0) {
    return 1;
  }

  const titleTokens = new Set(tokenize(display.title));
  const pathTokens = new Set(tokenize(normalizedPath));
  let matchedUnits = 0;

  for (const queryToken of queryTokens) {
    if (titleTokens.has(queryToken) || pathTokens.has(queryToken)) {
      matchedUnits += 1;
      continue;
    }

    if (queryToken.length < 3) {
      continue;
    }

    const hasPartialMatch = [...titleTokens, ...pathTokens].some(
      (candidateToken) =>
        candidateToken.includes(queryToken) || queryToken.includes(candidateToken)
    );
    if (hasPartialMatch) {
      matchedUnits += 0.6;
    }
  }

  const coverage = Math.max(0, Math.min(1, matchedUnits / queryTokens.length));
  return Math.max(0, Math.min(1, 1 - coverage));
}

function compareAgentScriptCandidates(
  left: AgentScriptCandidate,
  right: AgentScriptCandidate
): number {
  const priority = (candidate: AgentScriptCandidate) => {
    if (candidate.reason === "matched_explicit_path") return 0;
    if (candidate.reason === "matched_explicit_id") return 1;
    if (candidate.reason === "matched_title_id") return 2;
    return 3;
  };
  const priorityDifference = priority(left) - priority(right);
  if (priorityDifference !== 0) return priorityDifference;
  const leftScore = normalizeAgentScriptCandidateScore(left.score) ?? 1;
  const rightScore = normalizeAgentScriptCandidateScore(right.score) ?? 1;
  if (leftScore !== rightScore) {
    return leftScore - rightScore;
  }

  const leftDisplay = formatAgentScriptDisplay(left.path);
  const rightDisplay = formatAgentScriptDisplay(right.path);
  const titleCompare = leftDisplay.title.localeCompare(rightDisplay.title);
  if (titleCompare !== 0) {
    return titleCompare;
  }

  return left.path.localeCompare(right.path);
}

export function getHighConfidenceAgentScriptCandidate(
  candidates: AgentScriptCandidate[],
  { isSwitchTarget }: { isSwitchTarget?: boolean } = {}
): AgentScriptCandidate | null {
  const sorted = candidates.filter((candidate) =>
    isListableAgentScriptPath(candidate.path) &&
    (isSwitchTarget === undefined || isNintendoSwitchAgentScriptPath(candidate.path) === isSwitchTarget)
  )
    .slice().sort(compareAgentScriptCandidates);
  const top = sorted[0];
  if (!top || typeof top.score !== "number" || !Number.isFinite(top.score) || top.score < 0 || top.score > 0.15) {
    return null;
  }
  if (["matched_explicit_path", "matched_explicit_id", "matched_title_id"].includes(top.reason ?? "")) {
    return top;
  }
  const runnerUp = sorted.find((candidate) =>
    normalizeAgentScriptPathForCompare(candidate.path) !== normalizeAgentScriptPathForCompare(top.path)
  );
  if (runnerUp && (normalizeAgentScriptCandidateScore(runnerUp.score) ?? 1) - top.score < 0.05) {
    return null;
  }
  return top;
}

export function buildAgentScriptCandidateList({
  query = "",
  searchContext,
  scripts = [],
  resolvedCandidates = [],
  resolvedPath = null,
  resolvedReason,
  resolvedScore,
  limit,
}: BuildAgentScriptCandidateListOptions): AgentScriptCandidate[] {
  const candidateMap = new Map<string, AgentScriptCandidate>();

  const addCandidate = (candidate: AgentScriptCandidate) => {
    const normalizedPath = normalizeString(candidate.path);
    if (!normalizedPath || !isListableAgentScriptPath(normalizedPath)) {
      return;
    }

    const compareKey = normalizeAgentScriptPathForCompare(normalizedPath);
    const existing = candidateMap.get(compareKey);
    // A listed path must not replace the resolver's evidence with a generic query score.
    if (existing && candidate.score === undefined) return;
    const heuristicScore = searchContext
      ? scoreAgentScriptForContext(searchContext, normalizedPath)
      : normalizeString(query) ? scoreAgentScriptForQuery(query ?? "", normalizedPath) : 1;
    const explicitScore = normalizeAgentScriptCandidateScore(candidate.score);
    const score = explicitScore ?? heuristicScore;
    const next = {
      path: normalizedPath,
      reason: candidate.reason ?? existing?.reason,
      score,
    };
    if (!existing || compareAgentScriptCandidates(next, existing) < 0) {
      candidateMap.set(compareKey, next);
    }
  };

  resolvedCandidates.forEach(addCandidate);
  if (resolvedPath) {
    addCandidate({
      path: resolvedPath,
      reason: resolvedReason,
      score: resolvedScore,
    });
  }
  scripts.forEach((scriptPath) => addCandidate({ path: scriptPath }));

  const candidates = Array.from(candidateMap.values()).sort(compareAgentScriptCandidates);
  return typeof limit === "number" && limit >= 0 ? candidates.slice(0, limit) : candidates;
}

export function filterAgentScriptCandidatesForQuery(
  candidates: AgentScriptCandidate[],
  query: string,
  limit = 80
): AgentScriptCandidate[] {
  const normalizedQuery = normalizeString(query);
  const ranked = candidates
    .filter((candidate) => isListableAgentScriptPath(candidate.path))
    .map((candidate) => ({
      candidate,
      score: scoreAgentScriptForQuery(normalizedQuery, candidate.path),
    }))
    .filter(({ score }) => !normalizedQuery || score < 1)
    .sort((left, right) => {
      if (left.score !== right.score) {
        return left.score - right.score;
      }
      return compareAgentScriptCandidates(left.candidate, right.candidate);
    })
    .map(({ candidate }) => candidate);

  return typeof limit === "number" && limit >= 0 ? ranked.slice(0, limit) : ranked;
}
