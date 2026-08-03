# Wayland overlay support

GSM uses two independent compatibility mechanisms on Wayland: one for overlay windows and one for global shortcuts.

## Overlay windows

On GNOME Wayland, GSM runs the overlay through XWayland by default. This provides reliable click-through behavior, pointer tracking, and window placement. Other Wayland compositors keep Electron's native backend by default. Native X11, Windows, and macOS keep their existing behavior.

These environment variables control only the overlay window backend:

- `GSM_OVERLAY_XWAYLAND_FEATURES=0` disables the XWayland path.
- `GSM_OVERLAY_XWAYLAND_FEATURES=1` enables the XWayland path on another Linux Wayland compositor for testing.

Enable this path only on a compositor where it has been tested.

## Global shortcuts

On GNOME Wayland, GSM routes overlay shortcuts through the XDG GlobalShortcuts portal by default. GNOME may display a portal dialog when GSM registers the shortcuts. Approve the request for the shortcuts to work.

Other compositors keep the existing hotkey behavior by default. The input-server setting can enable portal routing independently. Changing `GSM_OVERLAY_XWAYLAND_FEATURES` does not change hotkey routing.
