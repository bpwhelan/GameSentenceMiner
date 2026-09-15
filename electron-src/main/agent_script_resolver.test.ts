import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";

import {
    findAgentScriptById,
    listAgentScriptFiles,
    resolveSwitchAgentScript,
} from "./agent_script_resolver.js";

const tempRoots: string[] = [];

function makeTempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "gsm-agent-scripts-"));
    tempRoots.push(root);
    return root;
}

describe("agent script file listing", () => {
    afterEach(() => {
        for (const root of tempRoots.splice(0)) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("scans the directory tree and ignores private/library scripts", () => {
        const root = makeTempRoot();
        const nested = path.join(root, "nested");
        fs.mkdirSync(nested);
        const visible = path.join(root, "NS_01000AE01954A000_Unicorn_Overlord.js");
        const nestedVisible = path.join(nested, "PC_Example_Game.js");
        const privateScript = path.join(root, "_ExecutionWatch.js");
        const libraryScript = path.join(root, "libCitra.js");
        fs.writeFileSync(visible, "");
        fs.writeFileSync(nestedVisible, "");
        fs.writeFileSync(privateScript, "");
        fs.writeFileSync(libraryScript, "");
        expect(listAgentScriptFiles(root)).toEqual(
            [visible, nestedVisible].sort((a, b) => a.localeCompare(b))
        );
        expect(findAgentScriptById(root, "01000AE01954A000")).toBe(visible);
    });

    it("scans nested directories", () => {
        const root = makeTempRoot();
        const nested = path.join(root, "nested");
        fs.mkdirSync(nested);
        const visible = path.join(nested, "PC_Example_Game.js");
        fs.writeFileSync(visible, "");
        fs.writeFileSync(path.join(root, "libLoader.js"), "");

        expect(listAgentScriptFiles(root)).toEqual([visible]);
    });

    it("does not use PC scripts as YUZU fallback matches", () => {
        const root = makeTempRoot();
        const switchScript = path.join(root, "NS_0100A3501946E000_Octopath_Traveler_2.js");
        const pcScript = path.join(root, "PC_Steam_Unreal_OCTOPATH_TRAVELER_0.js");
        fs.writeFileSync(switchScript, "");
        fs.writeFileSync(pcScript, "");

        const result = resolveSwitchAgentScript({
            scriptsPath: root,
            processName: "yuzu.exe",
            windowTitle: "yuzu | Octopath Traveler 0 (64-bit)",
            sceneName: "Octopath Traveler 0",
            explicitGameId: null,
        });

        expect(result.path).not.toBe(pcScript);
        expect(result.candidates.every((candidate) => path.basename(candidate.path).startsWith("NS_"))).toBe(true);
    });

    it("includes executable matches even when the scene and window have different names", () => {
        const root = makeTempRoot();
        const script = path.join(root, "PC_Steam_Unicorn_Overlord.js");
        fs.writeFileSync(script, "");
        const result = resolveSwitchAgentScript({
            scriptsPath: root,
            sceneName: "My capture",
            windowTitle: "Loading…",
            processName: "C:\\Games\\UnicornOverlord-Win64-Shipping.exe",
        });
        expect(result.path).toBe(script);
        expect(result.candidates[0].score).toBeLessThanOrEqual(0.15);
    });

    it("includes and ranks matches from scene, title, and executable together", () => {
        const root = makeTempRoot();
        for (const name of ["PC_Tsukihime.js", "PC_Resident_Evil_HD_REMASTER.js", "PC_Unicorn_Overlord.js"]) {
            fs.writeFileSync(path.join(root, name), "");
        }
        const result = resolveSwitchAgentScript({
            scriptsPath: root,
            sceneName: "Tsukihime",
            windowTitle: "Resident Evil HD REMASTER",
            processName: "UnicornOverlord.exe",
        });
        expect(result.candidates.filter((candidate) => candidate.score <= 0.15)).toHaveLength(3);
    });

    it("does not match scripts using generic emulator or engine executable names", () => {
        const root = makeTempRoot();
        fs.writeFileSync(path.join(root, "PC_Game_UnityPlayer.js"), "");
        for (const processName of ["game.exe", "UnityPlayer.exe", "main.exe"]) {
            const result = resolveSwitchAgentScript({ scriptsPath: root, sceneName: "Scene", processName });
            expect(result.candidates).toEqual([]);
        }
    });

    it("preserves explicit and detected Switch title IDs over conflicting name hints", () => {
        const root = makeTempRoot();
        const first = path.join(root, "NS_01000AE01954A000_Unicorn_Overlord.js");
        const second = path.join(root, "NS_01001DC01486A000_Tsukihime.js");
        fs.writeFileSync(first, "");
        fs.writeFileSync(second, "");
        const input = { scriptsPath: root, processName: "yuzu.exe", sceneName: "Tsukihime", windowTitle: "yuzu | Tsukihime [01000AE01954A000]" };
        expect(resolveSwitchAgentScript(input)).toMatchObject({ path: first, reason: "matched_title_id" });
        expect(resolveSwitchAgentScript({ ...input, explicitGameId: "01001DC01486A000" })).toMatchObject({ path: second, reason: "matched_explicit_id" });
    });
});
