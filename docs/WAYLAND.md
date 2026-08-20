# Wayland overlay support

Wayland breaks the overlay in two separate ways, and GSM works around each one differently. One workaround covers the overlay window, the other covers global shortcuts. You configure them independently, so changing one does not affect the other.

## Overlay windows

On GNOME Wayland, GSM runs the overlay through XWayland by default.

Electron's native Wayland backend cannot do three things the overlay depends on. It cannot pass clicks through to the game underneath, it cannot read the pointer position outside its own surface, and it cannot place a window at absolute screen coordinates. XWayland restores all three.

Other Wayland compositors keep the native backend. Native X11, Windows and macOS are unchanged.

One environment variable controls the window backend and nothing else:

- `GSM_OVERLAY_XWAYLAND_FEATURES=0` forces the native backend on GNOME.
- `GSM_OVERLAY_XWAYLAND_FEATURES=1` forces XWayland on a non-GNOME compositor.

GNOME is the only compositor this path has been tested on. On others, click-through and window placement depend on how the compositor handles XWayland override-redirect windows, so treat `=1` as experimental.

## Global shortcuts

Wayland does not let an application grab global hotkeys for itself. On GNOME, GSM registers them through the XDG GlobalShortcuts portal instead. GNOME shows a permission dialog the first time GSM registers, and the shortcuts do nothing until you approve it.

When the portal service is not up yet, which happens if GSM starts early in a login session, the input server retries on a backoff from 1 second up to 60 seconds. It does not retry a request you actively deny, so restart GSM if you dismiss the dialog by mistake.

When the portal stays unavailable, the input server logs why, along with the command to bind the shortcut yourself:

```
gsm_overlay_server trigger <action_id> --port <port>
```

Bind that in your compositor's own keyboard settings to get the same behavior. The logged line has the real path and port filled in.

GSM turns portal routing on automatically for GNOME Wayland sessions. Other compositors keep the existing hotkey behavior until you enable "Route all hotkeys through input server" under Settings, Hotkeys. `GSM_OVERLAY_XWAYLAND_FEATURES` does not affect hotkey routing either way.
