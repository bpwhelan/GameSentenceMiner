import { getWindowsSystemExecutable } from './windows_tools.js';

type RunCommand = (
    executable: string,
    args: string[],
    options: { windowsHide: boolean; timeout: number },
) => Promise<unknown>;

/** Restore the exact managed OBS instance, including its hidden system tray window. */
export async function showWindowsOBSWindow(pid: number, runCommand: RunCommand): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error('Cannot show OBS without a valid process ID.');
    }

    // MainWindowHandle is zero when OBS is in the tray. Find its hidden Qt tray
    // receiver too: showing the native HWND alone leaves Qt's widgets hidden.
    const script = `
$ErrorActionPreference = 'Stop'
$obsProcess = Get-Process -Id ${pid} -ErrorAction Stop
try {
    $null = $obsProcess.Handle
    if ($obsProcess.HasExited -or $obsProcess.ProcessName -notmatch '^obs(32|64)?$') {
        throw 'The saved process ID no longer belongs to a running OBS.'
    }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class GsmObsShowWindow {
    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder text, int maxCount);
    [DllImport("user32.dll")]
    private static extern bool ShowWindowAsync(IntPtr window, int command);
    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    private static extern IntPtr GetLastActivePopup(IntPtr window);
    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam,
        IntPtr lParam, uint flags, uint timeout, out UIntPtr result);

    public static IntPtr FindWindow(uint processId, bool tray) {
        IntPtr result = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != processId) return true;
            var title = new StringBuilder(512);
            var windowClass = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity);
            GetClassName(window, windowClass, windowClass.Capacity);
            bool matches = tray
                ? title.ToString() == "QTrayIconMessageWindow" &&
                    windowClass.ToString().EndsWith("TrayIconMessageWindowClass", StringComparison.Ordinal)
                : title.ToString().StartsWith("OBS ", StringComparison.Ordinal) &&
                    windowClass.ToString().StartsWith("Qt", StringComparison.Ordinal);
            if (!matches) return true;
            result = window;
            return false;
        }, IntPtr.Zero);
        return result;
    }

    private static void ActivateTrayIcon(IntPtr trayWindow) {
        // Qt's tray callback is WM_APP + 101 with NIN_SELECT (icon ID zero).
        // See qtbase/src/plugins/platforms/windows/qwindowssystemtrayicon.cpp.
        // This runs OBS's IconActivated/SetShowing path, restoring its widgets
        // and preview as well as the native window. Bound an unresponsive OBS.
        UIntPtr result;
        if (SendMessageTimeout(trayWindow, 0x8065, UIntPtr.Zero,
            new IntPtr(0x0400), 0x0002, 1000, out result) == IntPtr.Zero) {
            throw new InvalidOperationException("OBS did not respond to its tray restore request.");
        }
    }

    public static bool Show(IntPtr window, IntPtr trayWindow) {
        if (!IsWindowVisible(window) || IsIconic(window)) {
            if (trayWindow != IntPtr.Zero) {
                ActivateTrayIcon(trayWindow);
                // Tray activation toggles visibility. A minimized window can
                // hide on the first activation; the second must leave it shown.
                if (!IsWindowVisible(window) || IsIconic(window)) ActivateTrayIcon(trayWindow);
            } else if (IsWindowVisible(window) && IsIconic(window)) {
                // A normally minimized window with the tray disabled already
                // has visible Qt widgets, so native SW_RESTORE is sufficient.
                ShowWindowAsync(window, 9);
            } else {
                // The tray may still be starting. Never expose an unpainted HWND.
                return false;
            }
        }
        if (!IsWindowVisible(window) || IsIconic(window)) return false;
        var popup = GetLastActivePopup(window);
        SetForegroundWindow(popup != IntPtr.Zero && IsWindowVisible(popup) ? popup : window);
        return true;
    }
}
'@
    # A click can also launch OBS. Give its GUI time to initialize before
    # restoring the window hidden by the startup-to-tray setting.
    $deadline = [Diagnostics.Stopwatch]::StartNew()
    if (!$obsProcess.WaitForInputIdle(10000)) {
        throw 'OBS is still starting. Try opening its window again.'
    }
    do {
        if ($obsProcess.HasExited) { throw 'OBS exited before its window could be shown.' }
        $window = [GsmObsShowWindow]::FindWindow(${pid}, $false)
        $trayWindow = [GsmObsShowWindow]::FindWindow(${pid}, $true)
        if ($window -ne [IntPtr]::Zero -and [GsmObsShowWindow]::Show($window, $trayWindow)) { exit 0 }
        Start-Sleep -Milliseconds 100
    } while ($deadline.ElapsedMilliseconds -lt 10000)
    throw 'OBS has no main window available to show.'
} finally {
    $obsProcess.Dispose()
}
`;

    await runCommand(
        getWindowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 15_000 },
    );
}
