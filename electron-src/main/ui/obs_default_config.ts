// Default OBS portable-config seeds, ported from the Python installer
// (GameSentenceMiner/util/downloader/download_tools.py + Untitled_json.py).
// Electron now owns the OBS download, so it must also seed the same config the
// Python path used to write — otherwise OBS would launch into its first-run
// wizard with no GSM profile/scene collection and no websocket server.

/** Replay-buffer profile (basic.ini) written for both the GSM and Untitled profiles. */
export function buildObsReplayBufferProfileIni(videosDir: string): string {
    return (
        '[SimpleOutput]\n' +
        `FilePath=${videosDir}\n` +
        'RecRB=true\n' +
        'RecRBTime=300\n' +
        'RecRBSize=512\n' +
        'RecAudioEncoder=opus\n' +
        'RecRBPrefix=GSM\n'
    );
}

/**
 * global.ini / user.ini seed that skips OBS's first-run prompts. FirstRun=true
 * skips the Auto-Configuration Wizard, LastVersion skips the "What's New"
 * migration dialog, and Profile/SceneCollection boot straight into the seeds
 * below. SysTray* starts OBS hidden in the tray so the user never sees it.
 */
export function buildObsGlobalIni(packedVersion: number | null): string {
    const lastVersionLine = packedVersion ? `LastVersion=${packedVersion}\n` : '';
    return (
        '[General]\n' +
        'FirstRun=true\n' +
        lastVersionLine +
        'Pre19Defaults=false\n' +
        'Pre21Defaults=false\n' +
        'Pre23Defaults=false\n' +
        'Pre24.1Defaults=false\n' +
        '\n' +
        '[Basic]\n' +
        'Profile=GSM\n' +
        'ProfileDir=GSM\n' +
        'SceneCollection=Untitled\n' +
        'SceneCollectionFile=Untitled\n' +
        '\n' +
        '[BasicWindow]\n' +
        'SysTrayEnabled=true\n' +
        'SysTrayWhenStarted=true\n'
    );
}

/**
 * Pack an OBS version string (e.g. "31.0.2") into OBS's LastVersion integer.
 * OBS stores it via MAKE_SEMANTIC_VERSION(major, minor, patch) =
 * (major << 24) | (minor << 16) | patch.
 */
export function packObsVersion(versionString: string | null | undefined): number | null {
    if (!versionString) {
        return null;
    }
    const match = /\s*v?(\d+)\.(\d+)(?:\.(\d+))?/.exec(versionString);
    if (!match) {
        return null;
    }
    const major = Number.parseInt(match[1], 10);
    const minor = Number.parseInt(match[2], 10);
    const patch = Number.parseInt(match[3] ?? '0', 10);
    return (major << 24) | (minor << 16) | patch;
}

/**
 * obs-browser ships a full CEF runtime in obs-plugins/64bit (libcef.dll alone is
 * ~200MB). GSM never uses browser sources, so the plugin + CEF is dead weight and
 * gets pruned after extraction. Mirrors OBS_BROWSER_CEF_FILES in download_tools.py.
 */
export const OBS_BROWSER_CEF_FILES: ReadonlySet<string> = new Set([
    'obs-browser.dll',
    'obs-browser-page.exe',
    'libcef.dll',
    'chrome_elf.dll',
    'libegl.dll',
    'libglesv2.dll',
    'icudtl.dat',
    'resources.pak',
    'chrome_100_percent.pak',
    'chrome_200_percent.pak',
    'v8_context_snapshot.bin',
    'snapshot_blob.bin',
]);

/**
 * Default "Untitled" scene collection, verbatim from Untitled_json.py. Contains
 * the GSM helper scene plus the hidden window/game capture probe sources GSM's
 * automatic scene setup relies on. The string is JSON; it is written to
 * config/obs-studio/basic/scenes/Untitled.json.
 */
export const OBS_DEFAULT_SCENE_JSON = `{
    "DesktopAudioDevice1": {
        "prev_ver": 536870915,
        "name": "Desktop Audio",
        "uuid": "8587cf13-6937-4e51-a1df-ed1ebb87d537",
        "id": "wasapi_output_capture",
        "versioned_id": "wasapi_output_capture",
        "settings": {
            "device_id": "default"
        },
        "mixers": 255,
        "sync": 0,
        "flags": 0,
        "volume": 1.0,
        "balance": 0.5,
        "enabled": true,
        "muted": true,
        "push-to-mute": false,
        "push-to-mute-delay": 0,
        "push-to-talk": false,
        "push-to-talk-delay": 0,
        "hotkeys": {
            "libobs.mute": [],
            "libobs.unmute": [],
            "libobs.push-to-mute": [],
            "libobs.push-to-talk": []
        },
        "deinterlace_mode": 0,
        "deinterlace_field_order": 0,
        "monitoring_type": 0,
        "private_settings": {}
    },
    "AuxAudioDevice1": {
        "prev_ver": 536870915,
        "name": "Mic/Aux",
        "uuid": "cbadac0a-b67a-46c9-9ff5-e649bff42549",
        "id": "wasapi_input_capture",
        "versioned_id": "wasapi_input_capture",
        "settings": {
            "device_id": "default"
        },
        "mixers": 255,
        "sync": 0,
        "flags": 0,
        "volume": 1.0,
        "balance": 0.5,
        "enabled": true,
        "muted": true,
        "push-to-mute": false,
        "push-to-mute-delay": 0,
        "push-to-talk": false,
        "push-to-talk-delay": 0,
        "hotkeys": {
            "libobs.mute": [],
            "libobs.unmute": [],
            "libobs.push-to-mute": [],
            "libobs.push-to-talk": []
        },
        "deinterlace_mode": 0,
        "deinterlace_field_order": 0,
        "monitoring_type": 0,
        "private_settings": {}
    },
    "current_scene": "GSM Helper - DONT TOUCH",
    "current_program_scene": "GSM Helper - DONT TOUCH",
    "scene_order": [
        {
            "name": "GSM Helper - DONT TOUCH"
        }
    ],
    "name": "Untitled",
    "sources": [
        {
            "prev_ver": 536870915,
            "name": "GSM Helper - DONT TOUCH",
            "uuid": "4eeba6c2-6272-4153-835b-0ae1d8190de8",
            "id": "scene",
            "versioned_id": "scene",
            "settings": {
                "id_counter": 2,
                "custom_size": false,
                "items": [
                    {
                        "name": "window_getter",
                        "source_uuid": "df836dc9-1431-4181-9ddf-8e268887bd03",
                        "visible": true,
                        "locked": false,
                        "rot": 0.0,
                        "scale_ref": {
                            "x": 1920.0,
                            "y": 1080.0
                        },
                        "align": 5,
                        "bounds_type": 2,
                        "bounds_align": 0,
                        "bounds_crop": false,
                        "crop_left": 0,
                        "crop_top": 0,
                        "crop_right": 0,
                        "crop_bottom": 0,
                        "id": 1,
                        "group_item_backup": false,
                        "pos": {
                            "x": 0.0,
                            "y": 0.0
                        },
                        "pos_rel": {
                            "x": -1.7777777910232544,
                            "y": -1.0
                        },
                        "scale": {
                            "x": 1.0,
                            "y": 1.0
                        },
                        "scale_rel": {
                            "x": 1.0,
                            "y": 1.0
                        },
                        "bounds": {
                            "x": 1920.0,
                            "y": 1080.0
                        },
                        "bounds_rel": {
                            "x": 3.555555582046509,
                            "y": 2.0
                        },
                        "scale_filter": "disable",
                        "blend_method": "default",
                        "blend_type": "normal",
                        "show_transition": {
                            "duration": 0
                        },
                        "hide_transition": {
                            "duration": 0
                        },
                        "private_settings": {}
                    },
                    {
                        "name": "game_window_getter",
                        "source_uuid": "9752dce6-8fd7-49b9-b438-fad95d97d6ce",
                        "visible": true,
                        "locked": false,
                        "rot": 0.0,
                        "scale_ref": {
                            "x": 1920.0,
                            "y": 1080.0
                        },
                        "align": 5,
                        "bounds_type": 2,
                        "bounds_align": 0,
                        "bounds_crop": false,
                        "crop_left": 0,
                        "crop_top": 0,
                        "crop_right": 0,
                        "crop_bottom": 0,
                        "id": 2,
                        "group_item_backup": false,
                        "pos": {
                            "x": 0.0,
                            "y": 0.0
                        },
                        "pos_rel": {
                            "x": -1.7777777910232544,
                            "y": -1.0
                        },
                        "scale": {
                            "x": 1.0,
                            "y": 1.0
                        },
                        "scale_rel": {
                            "x": 1.0,
                            "y": 1.0
                        },
                        "bounds": {
                            "x": 1920.0,
                            "y": 1080.0
                        },
                        "bounds_rel": {
                            "x": 3.555555582046509,
                            "y": 2.0
                        },
                        "scale_filter": "disable",
                        "blend_method": "default",
                        "blend_type": "normal",
                        "show_transition": {
                            "duration": 0
                        },
                        "hide_transition": {
                            "duration": 0
                        },
                        "private_settings": {}
                    }
                ]
            },
            "mixers": 0,
            "sync": 0,
            "flags": 0,
            "volume": 1.0,
            "balance": 0.5,
            "enabled": true,
            "muted": false,
            "push-to-mute": false,
            "push-to-mute-delay": 0,
            "push-to-talk": false,
            "push-to-talk-delay": 0,
            "hotkeys": {
                "OBSBasic.SelectScene": [],
                "libobs.show_scene_item.1": [],
                "libobs.hide_scene_item.1": [],
                "libobs.show_scene_item.2": [],
                "libobs.hide_scene_item.2": []
            },
            "deinterlace_mode": 0,
            "deinterlace_field_order": 0,
            "monitoring_type": 0,
            "canvas_uuid": "6c69626f-6273-4c00-9d88-c5136d61696e",
            "private_settings": {}
        },
        {
            "prev_ver": 536870915,
            "name": "window_getter",
            "uuid": "df836dc9-1431-4181-9ddf-8e268887bd03",
            "id": "window_capture",
            "versioned_id": "window_capture",
            "settings": {},
            "mixers": 255,
            "sync": 0,
            "flags": 0,
            "volume": 1.0,
            "balance": 0.5,
            "enabled": true,
            "muted": false,
            "push-to-mute": false,
            "push-to-mute-delay": 0,
            "push-to-talk": false,
            "push-to-talk-delay": 0,
            "hotkeys": {
                "libobs.mute": [],
                "libobs.unmute": [],
                "libobs.push-to-mute": [],
                "libobs.push-to-talk": []
            },
            "deinterlace_mode": 0,
            "deinterlace_field_order": 0,
            "monitoring_type": 0,
            "private_settings": {}
        },
        {
            "prev_ver": 536870915,
            "name": "game_window_getter",
            "uuid": "9752dce6-8fd7-49b9-b438-fad95d97d6ce",
            "id": "game_capture",
            "versioned_id": "game_capture",
            "settings": {},
            "mixers": 255,
            "sync": 0,
            "flags": 0,
            "volume": 1.0,
            "balance": 0.5,
            "enabled": true,
            "muted": false,
            "push-to-mute": false,
            "push-to-mute-delay": 0,
            "push-to-talk": false,
            "push-to-talk-delay": 0,
            "hotkeys": {
                "libobs.mute": [],
                "libobs.unmute": [],
                "libobs.push-to-mute": [],
                "libobs.push-to-talk": [],
                "hotkey_start": [],
                "hotkey_stop": []
            },
            "deinterlace_mode": 0,
            "deinterlace_field_order": 0,
            "monitoring_type": 0,
            "private_settings": {}
        }
    ],
    "groups": [],
    "quick_transitions": [
        {
            "name": "Cut",
            "duration": 300,
            "hotkeys": [],
            "id": 1,
            "fade_to_black": false
        },
        {
            "name": "Fade",
            "duration": 300,
            "hotkeys": [],
            "id": 2,
            "fade_to_black": false
        },
        {
            "name": "Fade",
            "duration": 300,
            "hotkeys": [],
            "id": 3,
            "fade_to_black": true
        }
    ],
    "transitions": [],
    "saved_projectors": [],
    "canvases": [],
    "current_transition": "Fade",
    "transition_duration": 300,
    "preview_locked": false,
    "scaling_enabled": false,
    "scaling_level": -18,
    "scaling_off_x": 0.0,
    "scaling_off_y": 0.0,
    "virtual-camera": {
        "type2": 3
    },
    "modules": {
        "scripts-tool": [],
        "output-timer": {
            "streamTimerHours": 0,
            "streamTimerMinutes": 0,
            "streamTimerSeconds": 30,
            "recordTimerHours": 0,
            "recordTimerMinutes": 0,
            "recordTimerSeconds": 30,
            "autoStartStreamTimer": false,
            "autoStartRecordTimer": false,
            "pauseRecordTimer": true
        },
        "auto-scene-switcher": {
            "interval": 300,
            "non_matching_scene": "",
            "switch_if_not_matching": false,
            "active": false,
            "switches": []
        },
        "captions": {
            "source": "",
            "enabled": false,
            "lang_id": 1033,
            "provider": "mssapi"
        },
        "advanced-scene-switcher": {
            "sceneGroups": [],
            "macros": [],
            "macroSettings": {
                "highlightExecuted": false,
                "highlightConditions": false,
                "highlightActions": false,
                "newMacroCheckInParallel": false,
                "newMacroRegisterHotkey": false,
                "newMacroUseShortCircuitEvaluation": false,
                "saveSettingsOnMacroChange": true
            },
            "variables": [],
            "switches": [],
            "ignoreWindows": [],
            "screenRegion": [],
            "pauseEntries": [],
            "sceneRoundTrip": [],
            "sceneTransitions": [],
            "defaultTransitions": [],
            "defTransitionDelay": 0,
            "ignoreIdleWindows": [],
            "idleTargetType": 0,
            "idleSceneName": "",
            "idleTransitionName": "",
            "idleEnable": false,
            "idleTime": 60,
            "executableSwitches": [],
            "randomSwitches": [],
            "fileSwitches": [],
            "readEnabled": false,
            "readPath": "",
            "writeEnabled": false,
            "writePath": "",
            "mediaSwitches": [],
            "timeSwitches": [],
            "audioSwitches": [],
            "audioFallbackTargetType": 0,
            "audioFallbackScene": "",
            "audioFallbackTransition": "",
            "audioFallbackEnable": false,
            "audioFallbackDuration": {
                "value": {
                    "value": 0.0,
                    "type": 0
                },
                "unit": 0,
                "version": 1
            },
            "videoSwitches": [],
            "interval": 300,
            "noMatchScene": {
                "sceneSelection": {
                    "type": 0,
                    "name": "",
                    "canvasSelection": "Main"
                }
            },
            "switch_if_not_matching": 0,
            "noMatchDelay": {
                "value": {
                    "value": 0.0,
                    "type": 0
                },
                "unit": 0,
                "version": 1
            },
            "cooldown": {
                "value": {
                    "value": 0.0,
                    "type": 0
                },
                "unit": 0,
                "version": 1
            },
            "enableCooldown": false,
            "active": true,
            "startup_behavior": 0,
            "autoStart": {
                "event": 0,
                "useAutoStartScene": false,
                "sceneSelection": {
                    "type": 0,
                    "name": "",
                    "canvasSelection": "Main"
                },
                "name": "",
                "regexConfig": {
                    "enable": false,
                    "partial": false,
                    "options": 0
                }
            },
            "logLevel": 0,
            "logLevelVersion": 1,
            "showSystemTrayNotifications": false,
            "disableHints": false,
            "disableFilterComboboxFilter": false,
            "warnPluginLoadFailure": true,
            "hideLegacyTabs": true,
            "priority0": 10,
            "priority1": 0,
            "priority2": 2,
            "priority3": 8,
            "priority4": 6,
            "priority5": 9,
            "priority6": 7,
            "priority7": 4,
            "priority8": 1,
            "priority9": 5,
            "priority10": 3,
            "threadPriority": 3,
            "transitionOverrideOverride": false,
            "adjustActiveTransitionType": true,
            "lastImportPath": "",
            "startHotkey": [],
            "stopHotkey": [],
            "toggleHotkey": [],
            "newMacroHotkey": [
                {
                    "control": true,
                    "key": "OBS_KEY_N"
                }
            ],
            "upMacroSegmentHotkey": [],
            "downMacroSegmentHotkey": [],
            "removeMacroSegmentHotkey": [],
            "tabWidgetOrder": [
                {
                    "generalTab": 0
                },
                {
                    "macroTab": 1
                },
                {
                    "windowTitleTab": 2
                },
                {
                    "executableTab": 3
                },
                {
                    "screenRegionTab": 4
                },
                {
                    "mediaTab": 5
                },
                {
                    "fileTab": 6
                },
                {
                    "randomTab": 7
                },
                {
                    "timeTab": 8
                },
                {
                    "idleTab": 9
                },
                {
                    "sceneSequenceTab": 10
                },
                {
                    "audioTab": 11
                },
                {
                    "videoTab": 12
                },
                {
                    "sceneGroupTab": 13
                },
                {
                    "transitionsTab": 14
                },
                {
                    "pauseTab": 15
                },
                {
                    "websocketConnectionTab": 16
                },
                {
                    "mqttConnectionTab": 17
                },
                {
                    "twitchConnectionTab": 18
                },
                {
                    "variableTab": 19
                },
                {
                    "actionQueueTab": 20
                }
            ],
            "saveWindowGeo": false,
            "windowPosX": 0,
            "windowPosY": 0,
            "windowWidth": 0,
            "windowHeight": 0,
            "macroListMacroEditSplitterPosition": [],
            "version": "de20c93b1482f98ab901f60bac264c7082ac57e3",
            "macroSearchSettings": {
                "showAlways": false,
                "searchType": 0,
                "searchString": "",
                "regexConfig": {
                    "enable": false,
                    "partial": false,
                    "options": 0
                }
            },
            "tabSettings": {
                "searchType": 0,
                "searchString": "",
                "regexConfig": {
                    "enable": false,
                    "partial": false,
                    "options": 0
                }
            },
            "dockSettings": {
                "searchType": 0,
                "searchString": "",
                "regexConfig": {
                    "enable": false,
                    "partial": false,
                    "options": 0
                }
            },
            "addVariablesDock": false,
            "websocketConnections": [],
            "mqttConnections": [],
            "twitchConnections": [],
            "actionQueues": [],
            "dockWindows": {
                "docks": []
            }
        }
    },
    "resolution": {
        "x": 1920,
        "y": 1080
    },
    "version": 2
}`;
