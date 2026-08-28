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
});
