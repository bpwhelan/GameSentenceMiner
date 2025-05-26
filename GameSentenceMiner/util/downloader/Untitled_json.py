scenes="""{
    "DesktopAudioDevice1": {
        "prev_ver": 520093697,
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
        "prev_ver": 520093697,
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
    "current_scene": "Yuzu",
    "current_program_scene": "Yuzu",
    "scene_order": [
        {
            "name": "Example Game Capture"
        },
        {
            "name": "Example Window Capture"
        },
        {
            "name": "Yuzu"
        }
    ],
    "name": "Untitled",
    "sources": [
        {
            "prev_ver": 520093697,
            "name": "Game Capture",
            "uuid": "3060072f-58ed-4c34-8bdc-a1e66507e99f",
            "id": "game_capture",
            "versioned_id": "game_capture",
            "settings": {
                "capture_audio": true
            },
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
        },
        {
            "prev_ver": 520093697,
            "name": "Example Game Capture",
            "uuid": "13da3321-7d49-4a97-b4c5-b1f0912c6440",
            "id": "scene",
            "versioned_id": "scene",
            "settings": {
                "id_counter": 1,
                "custom_size": false,
                "items": [
                    {
                        "name": "Game Capture",
                        "source_uuid": "3060072f-58ed-4c34-8bdc-a1e66507e99f",
                        "visible": true,
                        "locked": false,
                        "rot": 0.0,
                        "scale_ref": {
                            "x": 1920.0,
                            "y": 1080.0
                        },
                        "align": 5,
                        "bounds_type": 0,
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
                            "x": 0.0,
                            "y": 0.0
                        },
                        "bounds_rel": {
                            "x": 0.0,
                            "y": 0.0
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
                "libobs.hide_scene_item.1": []
            },
            "deinterlace_mode": 0,
            "deinterlace_field_order": 0,
            "monitoring_type": 0,
            "private_settings": {}
        },
        {
            "prev_ver": 520093697,
            "name": "Example Window Capture",
            "uuid": "313ace86-d326-4bc4-bb70-69a64cd3b995",
            "id": "scene",
            "versioned_id": "scene",
            "settings": {
                "id_counter": 2,
                "custom_size": false,
                "items": [
                    {
                        "name": "Window Capture",
                        "source_uuid": "35e6ccb1-1559-4f0a-a26f-f3d4faa4acb4",
                        "visible": true,
                        "locked": false,
                        "rot": 0.0,
                        "scale_ref": {
                            "x": 1920.0,
                            "y": 1080.0
                        },
                        "align": 5,
                        "bounds_type": 0,
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
                            "x": 0.0,
                            "y": 0.0
                        },
                        "bounds_rel": {
                            "x": 0.0,
                            "y": 0.0
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
                "libobs.show_scene_item.2": [],
                "libobs.hide_scene_item.2": []
            },
            "deinterlace_mode": 0,
            "deinterlace_field_order": 0,
            "monitoring_type": 0,
            "private_settings": {}
        },
        {
            "prev_ver": 520093697,
            "name": "Yuzu",
            "uuid": "68d18b0a-7b81-4dd6-8a29-5bd882f9b8d8",
            "id": "scene",
            "versioned_id": "scene",
            "settings": {
                "id_counter": 2,
                "custom_size": false,
                "items": [
                    {
                        "name": "Window Capture",
                        "source_uuid": "35e6ccb1-1559-4f0a-a26f-f3d4faa4acb4",
                        "visible": true,
                        "locked": false,
                        "rot": 0.0,
                        "scale_ref": {
                            "x": 1920.0,
                            "y": 1080.0
                        },
                        "align": 5,
                        "bounds_type": 0,
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
                            "x": 0.0,
                            "y": 0.0
                        },
                        "bounds_rel": {
                            "x": 0.0,
                            "y": 0.0
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
                "libobs.show_scene_item.2": [],
                "libobs.hide_scene_item.2": []
            },
            "deinterlace_mode": 0,
            "deinterlace_field_order": 0,
            "monitoring_type": 0,
            "private_settings": {}
        },
        {
            "prev_ver": 520093697,
            "name": "Window Capture",
            "uuid": "35e6ccb1-1559-4f0a-a26f-f3d4faa4acb4",
            "id": "window_capture",
            "versioned_id": "window_capture",
            "settings": {
                "capture_audio": true
            },
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
    "current_transition": "Fade",
    "transition_duration": 300,
    "preview_locked": false,
    "scaling_enabled": false,
    "scaling_level": 0,
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
        }
    },
    "version": 2
}"""