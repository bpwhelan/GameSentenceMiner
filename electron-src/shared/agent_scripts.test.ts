import { describe, expect, it } from "vitest";

import {
    buildAgentScriptCandidateList,
    filterAgentScriptCandidatesForQuery,
    formatAgentScriptDisplay,
    getHighConfidenceAgentScriptCandidate,
    isListableAgentScriptPath,
    scoreAgentScriptForContext,
    scoreAgentScriptForQuery,
} from "./agent_scripts.js";

describe("agent script helpers", () => {
    it("ignores private and library script files", () => {
        expect(isListableAgentScriptPath(".\\_ExecutionWatch.js")).toBe(false);
        expect(isListableAgentScriptPath(".\\libCitra.js")).toBe(false);
        expect(isListableAgentScriptPath(".\\NS_01000AE01954A000_Unicorn_Overlord.js")).toBe(true);
    });

    it("formats agent script file names as readable game labels", () => {
        expect(
            formatAgentScriptDisplay(
                "C:\\Agent\\data\\scripts\\NS_01000AE01954A000_Unicorn_Overlord.js"
            )
        ).toMatchObject({
            title: "Unicorn Overlord",
            metadata: "Switch | 01000AE01954A000",
        });

        expect(
            formatAgentScriptDisplay(
                "C:\\Agent\\data\\scripts\\3DS_Japan_Devil_Survivor_2_Record_Breaker.js"
            )
        ).toMatchObject({
            title: "Devil Survivor 2 Record Breaker",
            metadata: "3DS | Japan",
        });

        expect(
            formatAgentScriptDisplay(
                "C:\\Agent\\data\\scripts\\NS_01001DC01486A000_Tsukihime_EN.js"
            )
        ).toMatchObject({
            title: "Tsukihime",
            metadata: "Switch | 01001DC01486A000 | English",
        });

        expect(
            formatAgentScriptDisplay(
                "C:\\Agent\\data\\scripts\\PC_Steam_Unity_AI_The_Somnium_Files_-_nirvanA_Initiative.js"
            )
        ).toMatchObject({
            title: "AI The Somnium Files - nirvanA Initiative",
            metadata: "PC | Steam | Unity",
        });

        expect(
            formatAgentScriptDisplay(
                "C:\\Agent\\data\\scripts\\PS2_SLPM65732_Akai_Ito.js"
            )
        ).toMatchObject({
            title: "Akai Ito",
            metadata: "PS2 | SLPM65732",
        });

        expect(
            formatAgentScriptDisplay(
                "C:\\Agent\\data\\scripts\\PC98_Leaf_Kizuato.js"
            )
        ).toMatchObject({
            title: "Kizuato",
            metadata: "PC-98 | Leaf",
        });

        expect(
            formatAgentScriptDisplay(
                "C:\\Agent\\data\\scripts\\HCode\\v16032_TAISHOxALICE_Episode_1.js"
            )
        ).toMatchObject({
            title: "TAISHOxALICE Episode 1",
            metadata: "H-Code | v16032",
        });
    });

    it("centralizes candidate ranking and query filtering", () => {
        const candidates = buildAgentScriptCandidateList({
            query: "Unicorn Overlord",
            scripts: [
                "C:\\Agent\\data\\scripts\\PC_Unrelated_Game.js",
                "C:\\Agent\\data\\scripts\\NS_01000AE01954A000_Unicorn_Overlord.js",
            ],
            resolvedCandidates: [
                {
                    path: "C:\\Agent\\data\\scripts\\NS_01000AE01954A000_Unicorn_Overlord.js",
                    reason: "matched_name",
                    score: 0.12,
                },
            ],
        });

        expect(candidates[0]).toMatchObject({
            path: "C:\\Agent\\data\\scripts\\NS_01000AE01954A000_Unicorn_Overlord.js",
            reason: "matched_name",
        });

        expect(filterAgentScriptCandidatesForQuery(candidates, "unicorn")).toEqual([
            candidates[0],
        ]);
    });

    it("matches title substrings in either direction despite separators", () => {
        const scriptPath =
            "C:\\Agent\\data\\scripts\\PC_Steam_Resident_Evil_HD_REMASTER.js";

        expect(scoreAgentScriptForQuery("ResidentEvil", scriptPath)).toBeLessThan(0.1);
        expect(
            scoreAgentScriptForQuery(
                "CAPCOM | Resident Evil HD REMASTER™ | DirectX 11",
                scriptPath
            )
        ).toBeLessThan(0.1);
    });

    it("ranks all capture hints without filtering out executable or scene matches", () => {
        const candidates = buildAgentScriptCandidateList({
            searchContext: {
                sceneName: "Tsukihime",
                windowTitle: "Resident Evil HD REMASTER",
                processName: "C:\\Games\\UnicornOverlord-Win64-Shipping.exe",
            },
            scripts: ["PC_Unrelated.js", "PC_Tsukihime.js", "PC_Resident_Evil_HD_REMASTER.js", "PC_Unicorn_Overlord.js"],
        });
        expect(candidates.slice(0, 3).map((candidate) => candidate.path)).toEqual(
            expect.arrayContaining(["PC_Tsukihime.js", "PC_Resident_Evil_HD_REMASTER.js", "PC_Unicorn_Overlord.js"])
        );
        expect(candidates[3]).toMatchObject({ path: "PC_Unrelated.js", score: 1 });
        expect(getHighConfidenceAgentScriptCandidate(candidates)).toBeNull();
    });

    it("uses corroborating context to rank otherwise equally strong matches", () => {
        const candidates = buildAgentScriptCandidateList({
            searchContext: {
                sceneName: "Tsukihime",
                windowTitle: "Resident Evil HD REMASTER",
                processName: "ResidentEvil.exe",
            },
            scripts: ["PC_Tsukihime.js", "PC_Resident_Evil_HD_REMASTER.js"],
        });
        expect(candidates[0].path).toBe("PC_Resident_Evil_HD_REMASTER.js");
        expect(candidates[0].score).toBeLessThan(candidates[1].score!);
    });

    it("does not invent high confidence from blank, generic, or repeated partial context", () => {
        const candidates = buildAgentScriptCandidateList({ scripts: ["PC_Game.js", "PC_Persona_4.js"] });
        expect(candidates.every((candidate) => candidate.score === 1)).toBe(true);
        expect(getHighConfidenceAgentScriptCandidate(candidates)).toBeNull();
        for (const processName of ["game.exe", "C:\\Games\\main.exe", "yuzu.exe", "UnityPlayer.exe", "nw.exe"]) {
            expect(scoreAgentScriptForContext({ processName }, "PC_Game_UnityPlayer_NW.js")).toBe(1);
        }
        expect(scoreAgentScriptForContext({ sceneName: "Persona", windowTitle: "Persona", processName: "Persona.exe" }, "PC_Persona_4.js")).toBeGreaterThan(0.15);
        expect(scoreAgentScriptForContext({ sceneName: "Octopath Traveler 0" }, "PC_Octopath_Traveler_2.js")).toBeGreaterThan(0.15);
        expect(scoreAgentScriptForContext({ windowTitle: "Persona 4 - Golden" }, "PC_Persona_4.js")).toBeGreaterThan(0.15);
    });

    it("preserves resolver scores and explicit ID precedence over title guesses", () => {
        const candidates = buildAgentScriptCandidateList({
            searchContext: { sceneName: "Persona 4" },
            scripts: ["PC_Persona_4.js", "NS_01000AE01954A000_Unicorn_Overlord.js"],
            resolvedCandidates: [
                { path: "PC_Persona_4.js", reason: "matched_fuzzy_name", score: 0.7 },
                { path: "NS_01000AE01954A000_Unicorn_Overlord.js", reason: "matched_title_id", score: 0.01 },
            ],
            resolvedPath: "PC_Persona_4.js",
        });
        expect(candidates[1]).toMatchObject({ path: "PC_Persona_4.js", score: 0.7 });
        expect(getHighConfidenceAgentScriptCandidate(candidates)?.path).toBe("NS_01000AE01954A000_Unicorn_Overlord.js");
    });

    it("keeps an explicitly chosen path before an equally scored inferred candidate", () => {
        const candidates = buildAgentScriptCandidateList({
            resolvedCandidates: [
                { path: "PC_Tsukihime.js", reason: "matched_name", score: 0 },
                { path: "NS_01000AE01954A000_Unicorn_Overlord.js", reason: "matched_title_id", score: 0.01 },
            ],
            resolvedPath: "PC_Tsukihime.js",
            resolvedReason: "matched_explicit_path",
            resolvedScore: 0,
        });
        expect(getHighConfidenceAgentScriptCandidate(candidates)).toMatchObject({ path: "PC_Tsukihime.js", reason: "matched_explicit_path" });
    });

    it("only recommends a clear high-confidence result", () => {
        expect(getHighConfidenceAgentScriptCandidate([{ path: "PC_Tsukihime.js", score: 0.04 }, { path: "PC_Other.js", score: 0.8 }])?.path).toBe("PC_Tsukihime.js");
        expect(getHighConfidenceAgentScriptCandidate([{ path: "PC_Tsukihime.js", score: 0.04 }, { path: "PC_Tsukihime_EN.js", score: 0.05 }])).toBeNull();
        expect(getHighConfidenceAgentScriptCandidate([{ path: "PC_Tsukihime.js", score: 0.3 }])).toBeNull();
        expect(getHighConfidenceAgentScriptCandidate([{ path: "PC_Tsukihime.js" }])).toBeNull();
    });

    it("does not recommend a different platform even when its title matches exactly", () => {
        const pc = { path: "PC_Tsukihime.js", score: 0.04 };
        const ns = { path: "NS_01001DC01486A000_Tsukihime.js", score: 0.04 };
        expect(getHighConfidenceAgentScriptCandidate([pc], { isSwitchTarget: true })).toBeNull();
        expect(getHighConfidenceAgentScriptCandidate([ns], { isSwitchTarget: false })).toBeNull();
        expect(getHighConfidenceAgentScriptCandidate([pc, ns], { isSwitchTarget: true })).toEqual(ns);
        expect(getHighConfidenceAgentScriptCandidate([pc, ns], { isSwitchTarget: false })).toEqual(pc);
    });
});
