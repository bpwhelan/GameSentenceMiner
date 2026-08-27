import { describe, expect, it } from 'vitest';

import {
    buildWaylandPipewireOption,
    buildCaptureCardOptions,
    buildLinuxSceneCaptureInputs,
    buildWindowsSceneCaptureInputs,
    mergeObsWindowItems,
    selectObsPipewireInputKind,
} from './obs-capture.js';

describe('Wayland PipeWire capture probing', () => {
    it('prefers OBS’s unified screen capture source when available', () => {
        expect(
            selectObsPipewireInputKind([
                'pipewire-desktop-capture-source',
                'pipewire-screen-capture-source',
                'pipewire-window-capture-source',
            ])
        ).toBe('pipewire-screen-capture-source');
    });

    it('falls back to split PipeWire source IDs used by newer OBS builds', () => {
        expect(
            selectObsPipewireInputKind(['pipewire-window-capture-source'])
        ).toBe('pipewire-window-capture-source');
        expect(
            selectObsPipewireInputKind(['pipewire-desktop-capture-source'])
        ).toBe('pipewire-desktop-capture-source');
    });

    it('does not advertise a Wayland candidate when OBS has no PipeWire source', () => {
        expect(buildWaylandPipewireOption(['window_capture', 'game_capture'])).toBeNull();
    });

    it('builds a portal-backed setup candidate from the detected OBS source', () => {
        expect(
            buildWaylandPipewireOption(['pipewire-screen-capture-source'])
        ).toEqual({
            title: 'Screen Capture (PipeWire)',
            value: 'pipewire-screen-capture-source',
            suggestedSceneName: 'Wayland Capture',
            targetKind: 'wayland_pipewire',
            pipewireInputKind: 'pipewire-screen-capture-source',
        });
    });
});

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
            targetKind: 'window',
            captureValues: {
                window_capture: 'Example Game:GameWindowClass:ExampleGame.exe',
                game_capture: 'Example Game:GameWindowClass:ExampleGame.exe',
            },
        });
    });

    it('skips invalid OBS window entries with no title, class, or executable', () => {
        const merged = mergeObsWindowItems([
            {
                itemName: '',
                itemValue: '::',
                captureMode: 'window_capture',
            },
            {
                itemName: 'Window Capture: Example Game',
                itemValue: 'Example Game:GameWindowClass:ExampleGame.exe',
                captureMode: 'window_capture',
            },
        ]);

        expect(merged).toHaveLength(1);
        expect(merged[0]).toMatchObject({
            title: 'Example Game',
            value: '["example game","gamewindowclass","examplegame.exe"]',
        });
    });
});

describe('buildCaptureCardOptions', () => {
    it('matches directshow and wasapi audio devices to a video capture device', () => {
        const captureCards = buildCaptureCardOptions(
            [
                {
                    itemName: 'Logi C525 HD Webcam',
                    itemValue: 'video-device-id',
                },
            ],
            [
                {
                    itemName: 'Microphone (Logi C525 HD WebCam)',
                    itemValue: 'dshow-audio-id',
                },
            ],
            [
                {
                    itemName: 'Microphone (Logi C525 HD WebCam)',
                    itemValue: 'wasapi-audio-id',
                },
            ]
        );

        expect(captureCards).toEqual([
            {
                title: 'Logi C525 HD Webcam',
                value: '["capture_card","video-device-id"]',
                targetKind: 'capture_card',
                videoDeviceId: 'video-device-id',
                audioDeviceId: 'dshow-audio-id',
                wasapiInputDeviceId: 'wasapi-audio-id',
            },
        ]);
    });

    it('filters obvious virtual cameras out of the capture-card list', () => {
        const captureCards = buildCaptureCardOptions(
            [
                {
                    itemName: 'OBS Virtual Camera',
                    itemValue: 'obs-virtual-camera',
                },
                {
                    itemName: 'HD60 X',
                    itemValue: 'hd60x',
                },
            ],
            [],
            []
        );

        expect(captureCards).toEqual([
            {
                title: 'HD60 X',
                value: '["capture_card","hd60x"]',
                targetKind: 'capture_card',
                videoDeviceId: 'hd60x',
                audioDeviceId: undefined,
                wasapiInputDeviceId: undefined,
            },
        ]);
    });
});

describe('buildWindowsSceneCaptureInputs', () => {
    it('defaults to a game-capture video source with separate application audio', () => {
        const plan = buildWindowsSceneCaptureInputs(
            'Example Game',
            {
                title: 'Example Game',
                value: '["example game","gamewindowclass","examplegame.exe"]',
                targetKind: 'window',
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

        expect(plan).toHaveLength(2);
        expect(plan[0]).toMatchObject({
            inputName: 'Example Game - Game Capture',
            inputKind: 'game_capture',
            sceneItemEnabled: true,
            inputSettings: {
                window: 'Example Game:GameWindowClass:ExampleGame.exe',
                capture_mode: 'window',
                capture_cursor: false,
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
        expect(plan.map((item) => item.inputKind)).not.toContain('window_capture');
        expect(plan[0].inputSettings).not.toHaveProperty('capture_audio');
    });

    it('creates a selected window-capture video source without game capture', () => {
        const plan = buildWindowsSceneCaptureInputs(
            'Example Game',
            {
                title: 'Example Game',
                value: '["example game","gamewindowclass","examplegame.exe"]',
                targetKind: 'window',
                captureMode: 'window_capture',
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

        expect(plan).toHaveLength(2);
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
        });
        expect(plan.map((item) => item.inputKind)).not.toContain('game_capture');
    });

    it('creates a capture-card scene with a paired audio input when a wasapi device matches', () => {
        const plan = buildWindowsSceneCaptureInputs(
            'Nintendo Switch',
            {
                title: 'HD60 X',
                value: '["capture_card","hd60x"]',
                targetKind: 'capture_card',
                videoDeviceId: 'hd60x-video-id',
                audioDeviceId: 'hd60x-dshow-audio-id',
                wasapiInputDeviceId: 'hd60x-wasapi-id',
            },
            {
                isWindows: true,
                isWindows10OrHigher: true,
            }
        );

        expect(plan).toHaveLength(2);
        expect(plan[0]).toMatchObject({
            inputName: 'HD60 X - Video Capture Device',
            inputKind: 'dshow_input',
            sceneItemEnabled: true,
            inputSettings: {
                video_device_id: 'hd60x-video-id',
            },
        });
        expect(plan[0].inputSettings).not.toHaveProperty('audio_device_id');
        expect(plan[1]).toMatchObject({
            inputName: 'HD60 X - Capture Card Audio',
            inputKind: 'wasapi_input_capture',
            sceneItemEnabled: true,
            inputSettings: {
                device_id: 'hd60x-wasapi-id',
            },
        });
    });

    it('falls back to directshow audio when no wasapi input match is available', () => {
        const plan = buildWindowsSceneCaptureInputs(
            'Nintendo Switch',
            {
                title: 'HD60 X',
                value: '["capture_card","hd60x"]',
                targetKind: 'capture_card',
                videoDeviceId: 'hd60x-video-id',
                audioDeviceId: 'hd60x-dshow-audio-id',
            },
            {
                isWindows: true,
                isWindows10OrHigher: true,
            }
        );

        expect(plan).toEqual([
            {
                inputName: 'HD60 X - Video Capture Device',
                inputKind: 'dshow_input',
                sceneItemEnabled: true,
                inputSettings: {
                    video_device_id: 'hd60x-video-id',
                    audio_device_id: 'hd60x-dshow-audio-id',
                },
            },
        ]);
    });

    it('rejects automatic scene setup outside Windows', () => {
        expect(() =>
            buildWindowsSceneCaptureInputs(
                'Example Game',
                {
                    title: 'Example Game',
                    value: 'legacy:value',
                    targetKind: 'window',
                },
                {
                    isWindows: false,
                    isWindows10OrHigher: false,
                }
            )
        ).toThrow(/only supported on Windows/i);
    });
});

describe('buildLinuxSceneCaptureInputs', () => {
    it('creates a PipeWire source that lets OBS open the Wayland chooser', () => {
        const plan = buildLinuxSceneCaptureInputs(
            'Wayland Game',
            {
                title: 'Screen Capture (PipeWire)',
                value: 'pipewire-screen-capture-source',
                targetKind: 'wayland_pipewire',
                pipewireInputKind: 'pipewire-screen-capture-source',
            },
            {
                isLinux: true,
            }
        );

        expect(plan).toEqual([
            {
                inputName: 'Wayland Game - Screen Capture (PipeWire)',
                inputKind: 'pipewire-screen-capture-source',
                inputSettings: {
                    ShowCursor: false,
                },
                sceneItemEnabled: true,
            },
        ]);
    });

    it('creates an XComposite capture plan from a Linux window selection', () => {
        const plan = buildLinuxSceneCaptureInputs(
            'NineSols',
            {
                title: 'NineSols',
                value: '161480705\r\nNineSols\r\nsteam_app_1809540',
                targetKind: 'window',
                captureValues: {
                    xcomposite_input:
                        '161480705\r\nNineSols\r\nsteam_app_1809540',
                },
            },
            {
                isLinux: true,
            }
        );

        expect(plan).toEqual([
            {
                inputName: 'NineSols - XComposite Window Capture',
                inputKind: 'xcomposite_input',
                sceneItemEnabled: true,
                inputSettings: {
                    capture_window:
                        '161480705\r\nNineSols\r\nsteam_app_1809540',
                    show_cursor: false,
                    include_border: false,
                    exclude_alpha: false,
                },
            },
        ]);
    });

    it('rejects Linux scene setup when no XComposite value is available', () => {
        expect(() =>
            buildLinuxSceneCaptureInputs(
                'NineSols',
                {
                    title: 'NineSols',
                    value: '',
                    targetKind: 'window',
                },
                {
                    isLinux: true,
                }
            )
        ).toThrow(/xcomposite/i);
    });
});
