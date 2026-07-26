"""Show a live Windows Graphics Capture preview of the active OBS game window.

Run from the repository root:

    uv run python scripts/show_obs_wgc_capture.py

Press Escape or Q to close the preview.
"""

from __future__ import annotations

import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))


def main() -> int:
    if sys.platform != "win32":
        print("This utility requires Windows Graphics Capture.")
        return 1

    import cv2
    import numpy as np
    import win32gui

    from GameSentenceMiner import obs
    from GameSentenceMiner.obs.screenshot_capture import (
        _capture_hwnd_windows_graphics_capture,
        screenshot_capture,
        stop_wgc_sessions,
    )
    from GameSentenceMiner.util.config.configuration import (
        DEFAULT_MAIN_WGC_CAPTURE_FPS,
        get_config,
        normalize_wgc_capture_fps,
    )

    preview_name = "GSM - Windows Graphics Capture"

    try:
        config = get_config()
        print(f"Connecting to OBS at {config.obs.host}:{config.obs.port}...")
        obs.connect_to_obs_sync(connections=1, start_manager=False)
        if obs.obs_service is None:
            raise RuntimeError("Could not connect to OBS. Make sure OBS is running.")

        scene_name = obs.get_current_scene()
        source = obs.get_source_from_scene(scene_name)
        source_name = source.get("sourceName") if isinstance(source, dict) else None
        settings = obs.get_current_source_input_settings()
        window_target = obs.parse_obs_window_target((settings or {}).get("window", ""))

        if not source_name:
            raise RuntimeError(f"No video capture source was found in OBS scene '{scene_name}'.")
        if not window_target:
            raise RuntimeError(
                f"OBS source '{source_name}' does not identify a window. "
                "Select a window in its Game Capture or Window Capture properties."
            )

        hwnd = screenshot_capture._find_hwnd(
            window_target["title"],
            window_target["window_class"],
            window_target["exe"],
        )
        if not hwnd:
            raise RuntimeError(f"Could not find the window configured by OBS source '{source_name}'.")
        if win32gui.IsIconic(hwnd):
            raise RuntimeError("The captured window is minimized. Restore it and run this utility again.")

        # capture_fps = normalize_wgc_capture_fps(
        #     getattr(config.advanced, "wgc_capture_fps", DEFAULT_MAIN_WGC_CAPTURE_FPS),
        #     DEFAULT_MAIN_WGC_CAPTURE_FPS,
        # )
        capture_fps = 60
        window_title = win32gui.GetWindowText(hwnd)
        print(f"Scene: {scene_name}")
        print(f"Source: {source_name}")
        print(f"Window: {window_title}")
        print(f"Previewing at {capture_fps} FPS. Press Escape or Q to close.")

        cv2.namedWindow(preview_name, cv2.WINDOW_NORMAL)
        first_frame = True

        while win32gui.IsWindow(hwnd):
            image = _capture_hwnd_windows_graphics_capture(hwnd, fps=capture_fps)
            frame = cv2.cvtColor(np.asarray(image), cv2.COLOR_RGB2BGR)

            if first_frame:
                height, width = frame.shape[:2]
                scale = min(1.0, 1280 / width, 720 / height)
                cv2.resizeWindow(preview_name, round(width * scale), round(height * scale))
                first_frame = False

            cv2.imshow(preview_name, frame)
            key = cv2.waitKey(max(1, round(1000 / capture_fps))) & 0xFF
            if key in (27, ord("q")):
                break
            if cv2.getWindowProperty(preview_name, cv2.WND_PROP_VISIBLE) < 1:
                break

        return 0
    except Exception as exc:
        print(f"Error: {exc}")
        return 1
    finally:
        stop_wgc_sessions()
        cv2.destroyAllWindows()
        obs.disconnect_from_obs()


if __name__ == "__main__":
    raise SystemExit(main())
