from .base_window_monitor import BaseWindowStateMonitor


class LinuxWindowStateMonitor(BaseWindowStateMonitor):
    """Linux window state monitor stub.

    Full window-state tracking (obscured/active/background) on Linux requires
    either X11 or Wayland protocol integration and is not yet implemented.
    Process pausing, which is handled entirely by module-level functions in
    base_window_monitor, works independently of this class.
    """

    pass
