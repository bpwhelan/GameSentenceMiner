import { getWindowsSystemExecutable } from './windows_tools.js';

type RunCommand = (
    executable: string,
    args: string[],
    options: { windowsHide: boolean; timeout: number }
) => Promise<unknown>;

/** Let OBS save its settings and finalize outputs; never escalate to termination. */
export async function closeWindowsOBSGracefully(pid: number, runCommand: RunCommand): Promise<void> {
    if (!Number.isSafeInteger(pid) || pid <= 0) {
        throw new Error('Cannot close OBS without a valid process ID.');
    }

    // Keep a handle to the verified process while requesting and waiting for its
    // exit. A PID saved by an earlier GSM session may have been reused.
    // CloseMainWindow cannot find OBS when it is hidden in the system tray, so
    // the fallback finds its main Qt window without showing it or closing any
    // windows owned by another process. WM_CLOSE still lets OBS prompt for an
    // active recording/stream; a prompt or a hang fails safely at the timeout.
    const script = `
$ErrorActionPreference = 'Stop'
$obsProcess = Get-Process -Id ${pid} -ErrorAction SilentlyContinue
if ($null -eq $obsProcess) { exit 0 }
try {
    $null = $obsProcess.Handle
    if ($obsProcess.HasExited) { exit 0 }
    if ($obsProcess.ProcessName -notmatch '^obs(32|64)?$') {
        throw 'The saved process ID no longer belongs to OBS.'
    }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class GsmObsCloseWindow {
    private delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr window, StringBuilder text, int maxCount);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr window, StringBuilder text, int maxCount);
    [DllImport("user32.dll", SetLastError = true)]
    private static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);

    public static bool RequestClose(uint processId) {
        bool posted = false;
        EnumWindows(delegate(IntPtr window, IntPtr parameter) {
            uint owner;
            GetWindowThreadProcessId(window, out owner);
            if (owner != processId) return true;
            var title = new StringBuilder(512);
            var windowClass = new StringBuilder(256);
            GetWindowText(window, title, title.Capacity);
            GetClassName(window, windowClass, windowClass.Capacity);
            if (!title.ToString().StartsWith("OBS ", StringComparison.Ordinal) ||
                !windowClass.ToString().StartsWith("Qt", StringComparison.Ordinal)) return true;
            posted = PostMessage(window, 0x0010, IntPtr.Zero, IntPtr.Zero);
            return !posted;
        }, IntPtr.Zero);
        return posted;
    }
}
'@
    if (!$obsProcess.CloseMainWindow() -and ![GsmObsCloseWindow]::RequestClose(${pid})) {
        if ($obsProcess.HasExited) { exit 0 }
        throw 'OBS has no main window to close. Close OBS manually and try again.'
    }
    if (!$obsProcess.WaitForExit(10000)) {
        throw 'OBS did not exit within 10 seconds. It was left running so its settings can be saved. Close OBS manually and try again.'
    }
} finally {
    $obsProcess.Dispose()
}
`;

    await runCommand(
        getWindowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 20_000 }
    );
}
