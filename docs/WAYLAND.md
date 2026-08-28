# Wayland overlay hotkeys

GSM routes overlay keyboard shortcuts through the XDG Desktop Portal on Wayland. The compositor owns the bindings and sends both `Activated` and `Deactivated` events, so Push-to-Show can follow the real key press and release without a global keyboard hook.

On KDE Plasma, the shortcut chooser may appear as a System Settings page rather than a conventional permission dialog. GSM's entries are listed under the application's desktop-file name. Plasma may initially show GSM's preferred combinations as defaults; apply them in the chooser to make them active.

The portal requires a normal key in every shortcut. Modifier-only shortcuts such as `Shift` and mouse shortcuts such as `Mouse4` are not supported. Use a combination such as `Shift+Space` for the Wayland portal path.

GSM resolves the actual installed `.desktop` filename before creating the portal session. Packaged builds use the stable ID `com.beangate.gamesentenceminer`; when an AppImage is launched from a fresh profile, GSM installs a hidden stable identity entry under the user's XDG applications directory so the portal can validate it. Existing AppImage launcher entries remain a compatibility fallback.

For diagnosing old X11 behavior only, `GSM_INPUT_SERVER_BACKEND=rdev` opts back into the raw input listener. It is not the default on Wayland.

References:

- [XDG Desktop Portal GlobalShortcuts interface](https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.GlobalShortcuts.html)
- [Electron globalShortcut API](https://www.electronjs.org/docs/latest/api/global-shortcut)
