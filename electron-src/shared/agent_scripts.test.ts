import { describe, expect, it } from "vitest";

import {
    buildAgentScriptCandidateList,
    filterAgentScriptCandidatesForQuery,
    formatAgentScriptDisplay,
    isListableAgentScriptPath,
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
});
