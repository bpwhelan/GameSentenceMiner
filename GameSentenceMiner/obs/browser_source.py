"""Identify OBS targets whose contents may disappear when the overlay takes focus."""

import ntpath

BROWSER_NAMES = frozenset(
    (
        "chrome",
        "msedge",
        "brave",
        "opera",
        "vivaldi",
        "chromium",
        "arc",
        "thorium",
        "whale",
        "yandex",
        "firefox",
        "zen",
        "waterfox",
        "librewolf",
        "floorp",
        "palemoon",
        "torbrowser",
    )
)

_BROWSER_SOURCE_NAMES = BROWSER_NAMES | {
    "google-chrome",
    "chromium-browser",
    "microsoft-edge",
    "brave-browser",
    "firefox-esr",
    "safari",
    "electron",
    "nw",
    "msedgewebview2",
}


def is_browser_window_source(info):
    window_class = (info.get("window_class") or info.get("wm_class") or "").strip().lower()
    exe = ntpath.basename(info.get("exe") or "").lower().removesuffix(".exe")
    return (
        window_class.startswith("chrome_widgetwin_")
        or window_class in {"mozillawindowclass", "opwindow", "cefbrowserwindow"}
        or window_class in _BROWSER_SOURCE_NAMES
        or exe in _BROWSER_SOURCE_NAMES
    )
