import { describe, expect, it } from 'vitest';

import {
    buildWindowsSceneCaptureInputs,
    mergeObsWindowItems,
} from './obs-capture.js';

describe('mergeObsWindowItems', () => {
    it('merges window and game capture entries for the same OBS window', () => {
        const merged = mergeObsWindowItems([
            {
                itemName: 'Window Capture: Example Game',
                itemValue: 'Example Game:GameWindowClass:ExampleGame.exe',
                captureMode: 'window_capture',
            },
            {
                itemName: 'Game Capture: Example Game',
                itemValue: 'Example Game:GameWindowClass:ExampleGame.exe',
                captureMode: 'game_capture',
            },
        ]);

        expect(merged).toHaveLength(1);
        expect(merged[0]).toMatchObject({
            title: 'Example Game',
            captureValues: {
                window_capture: 'Example Game:GameWindowClass:ExampleGame.exe',
                game_capture: 'Example Game:GameWindowClass:ExampleGame.exe',
            },
        });
    });
});

describe('buildWindowsSceneCaptureInputs', () => {
    it('creates a multi-source capture plan with separate application audio', () => {
        const plan = buildWindowsSceneCaptureInputs(
            'Example Game',
            {
                title: 'Example Game',
                value: '["example game","gamewindowclass","examplegame.exe"]',
                captureValues: {
                    window_capture: 'Example Game:GameWindowClass:ExampleGame.exe',
                    game_capture: 'Example Game:GameWindowClass:ExampleGame.exe',
                },
            },
            {
                isWindows: true,
                isWindows10OrHigher: true,
            }
        );

        expect(plan).toHaveLength(3);
        expect(plan[0]).toMatchObject({
            inputName: 'Example Game - Window Capture',
            inputKind: 'window_capture',
            sceneItemEnabled: true,
            inputSettings: {
                window: 'Example Game:GameWindowClass:ExampleGame.exe',
                mode: 'window',
                cursor: false,
                method: 2,
            },
        });
        expect(plan[1]).toMatchObject({
            inputName: 'Example Game - Audio Capture',
            inputKind: 'wasapi_process_output_capture',
            sceneItemEnabled: true,
            inputSettings: {
                window: 'Example Game:GameWindowClass:ExampleGame.exe',
            },
        });
        expect(plan[2]).toMatchObject({
            inputName: 'Example Game - Game Capture',
            inputKind: 'game_capture',
            sceneItemEnabled: true,
            inputSettings: {
                window: 'Example Game:GameWindowClass:ExampleGame.exe',
                capture_mode: 'window',
                capture_cursor: false,
            },
        });
        expect(plan[0].inputSettings).not.toHaveProperty('capture_audio');
        expect(plan[2].inputSettings).not.toHaveProperty('capture_audio');
    });

    it('rejects automatic scene setup outside Windows', () => {
        expect(() =>
            buildWindowsSceneCaptureInputs(
                'Example Game',
                {
                    title: 'Example Game',
                    value: 'legacy:value',
                },
                {
                    isWindows: false,
                    isWindows10OrHigher: false,
                }
            )
        ).toThrow(/only supported on Windows/i);
    });
});
