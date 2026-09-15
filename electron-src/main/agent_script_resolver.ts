import * as fs from "fs";
import * as path from "path";
import Fuse from "fuse.js";
import {
    getAgentScriptSearchQueries,
    isListableAgentScriptPath,
    isNintendoSwitchAgentScriptPath,
    scoreAgentScriptForContext,
} from "../shared/agent_scripts.js";

const SWITCH_EMULATOR_HINTS = [
    "yuzu",
    "suyu",
    "ryujinx",
    "eden",
    "citron",
    "sudachi",
    "torzu",
];

const MIN_AUTO_SELECT_CONFIDENCE = 0.85;
const MAX_MATCH_SCORE = 1;

export interface SwitchScriptResolutionInput {
    scriptsPath: string;
    processName?: string | null;
    windowTitle?: string | null;
    sceneName?: string | null;
    explicitGameId?: string | null;
}

export interface ScriptMatchCandidate {
    path: string;
    reason:
        | "matched_explicit_id"
        | "matched_title_id"
        | "matched_name"
        | "matched_fuzzy_name";
    score: number;
}

export interface SwitchScriptResolutionResult {
    path: string | null;
    reason:
        | "matched_explicit_id"
        | "matched_title_id"
        | "matched_name"
        | "matched_fuzzy_name"
        | "not_switch_target"
        | "scripts_path_missing"
        | "scripts_path_unreadable"
        | "no_match";
    isSwitchTarget: boolean;
    titleId: string | null;
    candidates: ScriptMatchCandidate[];
}

// Internal candidate scores use Fuse-style ranking where lower is better.
// Convert to confidence in [0, 1] when applying auto-selection heuristics.
export function scriptMatchScoreToConfidence(score: number): number {
    if (!Number.isFinite(score)) {
        return 0;
    }
    return Math.max(0, Math.min(1, MAX_MATCH_SCORE - score));
}

export function isHighConfidenceScriptMatch(score: number): boolean {
    return scriptMatchScoreToConfidence(score) >= MIN_AUTO_SELECT_CONFIDENCE;
}

function normalizePathValue(value: string | null | undefined): string {
    if (typeof value !== "string") {
        return "";
    }
    return value.trim();
}

function dedupe(values: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of values) {
        const key = value.toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            result.push(value);
        }
    }
    return result;
}

function dedupeScriptPaths(filePaths: string[]): string[] {
    const seen = new Set<string>();
    const result: string[] = [];
    for (const filePath of filePaths) {
        const key = path.normalize(filePath).toLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            result.push(filePath);
        }
    }
    return result;
}

export function listAgentScriptFiles(scriptsPath: string): string[] {
    try {
        if (!scriptsPath || !fs.existsSync(scriptsPath)) {
            return [];
        }

        const normalizedScriptsPath = path.resolve(scriptsPath);
        const rootStats = fs.statSync(normalizedScriptsPath);
        if (rootStats.isFile()) {
            return isListableAgentScriptPath(normalizedScriptsPath)
                ? [normalizedScriptsPath]
                : [];
        }
        if (!rootStats.isDirectory()) {
            return [];
        }

        const files: string[] = [];
        const pendingDirectories: string[] = [normalizedScriptsPath];

        while (pendingDirectories.length > 0) {
            const directory = pendingDirectories.pop();
            if (!directory) {
                continue;
            }

            let entries: fs.Dirent[];
            try {
                entries = fs.readdirSync(directory, { withFileTypes: true });
            } catch {
                continue;
            }

            for (const entry of entries) {
                const absolutePath = path.join(directory, entry.name);

                if (entry.isDirectory()) {
                    pendingDirectories.push(absolutePath);
                    continue;
                }

                if (entry.isFile() && isListableAgentScriptPath(absolutePath)) {
                    files.push(absolutePath);
                }
            }
        }

        return dedupeScriptPaths(files).sort((a, b) => a.localeCompare(b));
    } catch {
        return [];
    }
}

function normalizeCandidateId(value: string | null | undefined): string | null {
    if (!value || typeof value !== "string") {
        return null;
    }
    const trimmed = value.trim();
    if (!trimmed) {
        return null;
    }
    return trimmed.toUpperCase();
}

function extractHexTitleIds(value: string | null | undefined): string[] {
    if (!value || typeof value !== "string") {
        return [];
    }

    const ids = Array.from(value.matchAll(/\b([0-9a-f]{16})\b/gi)).map((match) =>
        match[1].toUpperCase()
    );
    return dedupe(ids);
}

function findScriptById(scriptFiles: string[], gameId: string): string | null {
    const normalizedId = gameId.toLowerCase();
    if (!normalizedId) {
        return null;
    }

    for (const filePath of scriptFiles) {
        const fileName = path.basename(filePath).toLowerCase();
        if (fileName.includes(normalizedId)) {
            return filePath;
        }
    }

    return null;
}

function normalizeFuzzyText(value: string): string {
    return value
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .replace(/\s+/g, " ")
        .trim();
}

function findFuzzyNameMatches(
    scriptFiles: string[],
    names: string[],
    maxResults: number = 15
): Array<{ path: string; score: number }> {
    const entries = scriptFiles.map((filePath) => {
        const fileName = path.basename(filePath, path.extname(filePath));
        return {
            path: filePath,
            name: fileName,
            normalized: normalizeFuzzyText(fileName),
        };
    });

    const fuse = new Fuse(entries, {
        includeScore: true,
        shouldSort: true,
        threshold: 0.8,
        ignoreLocation: true,
        minMatchCharLength: 2,
        keys: ["name", "normalized"],
    });

    const bestScores = new Map<string, number>();

    for (const name of names) {
        const query = normalizeFuzzyText(name);
        if (!query || query.length < 2) {
            continue;
        }

        const results = fuse.search(query, { limit: Math.max(maxResults * 3, 20) });
        if (results.length === 0) {
            continue;
        }

        for (const result of results) {
            const score = result.score ?? 1;
            if (score > 0.8) {
                continue;
            }
            const existing = bestScores.get(result.item.path);
            if (existing === undefined || score < existing) {
                bestScores.set(result.item.path, score);
            }
        }
    }

    return Array.from(bestScores.entries())
        .map(([candidatePath, score]) => ({ path: candidatePath, score }))
        .sort((a, b) => a.score - b.score)
        .slice(0, maxResults);
}

export function isSwitchEmulatorTarget(
    processName?: string | null,
    windowTitle?: string | null
): boolean {
    const normalizedProcess = normalizePathValue(processName).toLowerCase();
    const processBaseName = normalizedProcess ? path.basename(normalizedProcess) : "";
    const normalizedTitle =
        typeof windowTitle === "string" ? windowTitle.toLowerCase() : "";

    return SWITCH_EMULATOR_HINTS.some((hint) => {
        return processBaseName.includes(hint) || normalizedTitle.includes(hint);
    });
}

export function findAgentScriptById(scriptsPath: string, gameId: string): string | null {
    const normalizedScriptsPath = normalizePathValue(scriptsPath);
    const normalizedGameId = normalizeCandidateId(gameId);
    if (!normalizedScriptsPath || !normalizedGameId) {
        return null;
    }

    const scriptFiles = listAgentScriptFiles(normalizedScriptsPath);
    return findScriptById(scriptFiles, normalizedGameId);
}

export function resolveSwitchAgentScript(
    input: SwitchScriptResolutionInput
): SwitchScriptResolutionResult {
    const scriptsPath = normalizePathValue(input.scriptsPath);
    const isSwitchTarget = isSwitchEmulatorTarget(input.processName, input.windowTitle);
    const candidates = new Map<string, ScriptMatchCandidate>();

    const pushCandidate = (
        candidatePath: string,
        reason: ScriptMatchCandidate["reason"],
        score: number
    ) => {
        const existing = candidates.get(candidatePath);
        if (!existing || score < existing.score) {
            candidates.set(candidatePath, {
                path: candidatePath,
                reason,
                score,
            });
        }
    };

    const getSortedCandidates = (): ScriptMatchCandidate[] => {
        return Array.from(candidates.values()).sort((a, b) => a.score - b.score);
    };

    if (!scriptsPath || !fs.existsSync(scriptsPath)) {
        return {
            path: null,
            reason: "scripts_path_missing",
            isSwitchTarget,
            titleId: null,
            candidates: [],
        };
    }

    const scriptFiles = listAgentScriptFiles(scriptsPath);
    if (scriptFiles.length === 0) {
        return {
            path: null,
            reason: "scripts_path_unreadable",
            isSwitchTarget,
            titleId: null,
            candidates: [],
        };
    }

    const titleIdCandidates = isSwitchTarget
        ? dedupe([
            ...extractHexTitleIds(input.windowTitle),
            ...extractHexTitleIds(input.sceneName),
        ])
        : [];

    if (isSwitchTarget) {
        const explicitId = normalizeCandidateId(input.explicitGameId ?? null);
        if (explicitId) {
            const explicitMatch = findScriptById(scriptFiles, explicitId);
            if (explicitMatch) {
                pushCandidate(explicitMatch, "matched_explicit_id", 0.001);
                return {
                    path: explicitMatch,
                    reason: "matched_explicit_id",
                    isSwitchTarget,
                    titleId: explicitId,
                    candidates: getSortedCandidates(),
                };
            }
        }

        for (const titleId of titleIdCandidates) {
            const match = findScriptById(scriptFiles, titleId);
            if (match) {
                pushCandidate(match, "matched_title_id", 0.01);
                return {
                    path: match,
                    reason: "matched_title_id",
                    isSwitchTarget,
                    titleId,
                    candidates: getSortedCandidates(),
                };
            }
        }
    }

    const fallbackCandidateScripts = isSwitchTarget
        ? scriptFiles.filter((filePath) => isNintendoSwitchAgentScriptPath(filePath))
        : scriptFiles.filter((filePath) => !isNintendoSwitchAgentScriptPath(filePath));
    if (fallbackCandidateScripts.length === 0) {
        return {
            path: null,
            reason: "no_match",
            isSwitchTarget,
            titleId: titleIdCandidates[0] ?? null,
            candidates: [],
        };
    }

    const nameCandidates = getAgentScriptSearchQueries(input);
    fallbackCandidateScripts.forEach((scriptPath) => {
        const score = scoreAgentScriptForContext(input, scriptPath);
        if (score < 1) {
            pushCandidate(scriptPath, "matched_name", score);
        }
    });

    const fuzzyNameMatches = findFuzzyNameMatches(fallbackCandidateScripts, nameCandidates);
    fuzzyNameMatches.forEach((candidate, index) => {
        const adjustedScore = 0.2 + candidate.score + index * 0.001;
        pushCandidate(candidate.path, "matched_fuzzy_name", adjustedScore);
    });

    const sortedCandidates = getSortedCandidates();
    if (sortedCandidates.length > 0) {
        return {
            path: sortedCandidates[0].path,
            reason: sortedCandidates[0].reason,
            isSwitchTarget,
            titleId: titleIdCandidates[0] ?? null,
            candidates: sortedCandidates,
        };
    }

    return {
        path: null,
        reason: "no_match",
        isSwitchTarget,
        titleId: titleIdCandidates[0] ?? null,
        candidates: [],
    };
}
