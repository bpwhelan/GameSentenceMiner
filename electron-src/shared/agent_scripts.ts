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

export interface BuildAgentScriptCandidateListOptions {
  query?: string | null;
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

function tokenize(value: string): string[] {
  return value
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2);
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

export function scoreAgentScriptForQuery(query: string, scriptPath: string): number {
  const normalizedQuery = normalizeString(query).toLowerCase();
  if (!normalizedQuery) {
    return 0;
  }
  const normalizedPathQuery = normalizedQuery.replace(/\\/g, "/");

  const display = formatAgentScriptDisplay(scriptPath);
  const normalizedPath = normalizeAgentScriptPathForCompare(scriptPath);
  const normalizedFileName = display.fileName.toLowerCase();
  const normalizedTitle = display.title.toLowerCase();

  if (
    normalizedPath === normalizedPathQuery ||
    normalizedFileName === normalizedQuery ||
    normalizedTitle === normalizedQuery
  ) {
    return 0;
  }

  if (normalizedTitle.includes(normalizedQuery)) {
    return 0.05;
  }
  if (normalizedFileName.includes(normalizedQuery)) {
    return 0.1;
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

export function buildAgentScriptCandidateList({
  query = "",
  scripts = [],
  resolvedCandidates = [],
  resolvedPath = null,
  resolvedReason,
  resolvedScore = 0,
  limit,
}: BuildAgentScriptCandidateListOptions): AgentScriptCandidate[] {
  const candidateMap = new Map<string, AgentScriptCandidate>();

  const addCandidate = (candidate: AgentScriptCandidate) => {
    const normalizedPath = normalizeString(candidate.path);
    if (!normalizedPath || !isListableAgentScriptPath(normalizedPath)) {
      return;
    }

    const compareKey = normalizeAgentScriptPathForCompare(normalizedPath);
    const heuristicScore = scoreAgentScriptForQuery(query ?? "", normalizedPath);
    const explicitScore = normalizeAgentScriptCandidateScore(candidate.score);
    const score = explicitScore === null
      ? heuristicScore
      : Math.min(explicitScore, heuristicScore);
    const existing = candidateMap.get(compareKey);
    const existingScore = normalizeAgentScriptCandidateScore(existing?.score);

    if (!existing || existingScore === null || score < existingScore) {
      candidateMap.set(compareKey, {
        path: normalizedPath,
        reason: candidate.reason ?? existing?.reason,
        score,
      });
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
