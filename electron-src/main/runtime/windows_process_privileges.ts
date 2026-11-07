import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getWindowsSystemExecutable } from './windows_tools.js';

export interface PrivilegeTarget {
    exeName: string;
    pid?: number;
}

export interface ProcessPrivilege {
    pid: number;
    exeName: string;
    startedAt: string;
    elevated: boolean | null;
}

export interface ProcessPrivilegeResult {
    gsmElevated: boolean | null;
    processes: ProcessPrivilege[];
}

const execFileAsync = promisify(execFile);

/** Read token elevation with limited query rights; access denied means unknown, never elevated. */
export async function probeWindowsProcessPrivileges(targets: PrivilegeTarget[]): Promise<ProcessPrivilegeResult> {
    const payload = Buffer.from(JSON.stringify({ gsmPid: process.pid, targets }), 'utf8').toString('base64');
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public class GsmProcessPrivilegeInfo {
    public bool? Elevated;
    public string StartedAt;
    public string ExeName;
}
public static class GsmProcessPrivileges {
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    static extern bool GetTokenInformation(IntPtr token, int kind, out int value, int size, out int returned);
    public static GsmProcessPrivilegeInfo Read(int pid) {
        var info = new GsmProcessPrivilegeInfo();
        var process = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (process == IntPtr.Zero) return info;
        IntPtr token = IntPtr.Zero;
        try {
            var image = new StringBuilder(32768);
            int imageLength = image.Capacity;
            if (QueryFullProcessImageName(process, 0, image, ref imageLength))
                info.ExeName = System.IO.Path.GetFileName(image.ToString());
            long creation, exit, kernel, user;
            if (GetProcessTimes(process, out creation, out exit, out kernel, out user))
                info.StartedAt = creation.ToString();
            if (!OpenProcessToken(process, 0x0008, out token)) return info; // TOKEN_QUERY
            int elevated, returned;
            if (GetTokenInformation(token, 20, out elevated, sizeof(int), out returned)) // TokenElevation
                info.Elevated = elevated != 0;
            return info;
        } finally {
            if (token != IntPtr.Zero) CloseHandle(token);
            CloseHandle(process);
        }
    }
}
'@
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${payload}')) | ConvertFrom-Json
$gsm = [GsmProcessPrivileges]::Read($request.gsmPid)
$records = @()
if ($gsm.Elevated -eq $false) {
    $seen = @{}
    foreach ($target in $request.targets) {
        $candidates = @()
        try {
            if ($target.pid) {
                $candidates = @([Diagnostics.Process]::GetProcessById($target.pid))
            } else {
                $name = [IO.Path]::GetFileNameWithoutExtension($target.exeName)
                $candidates = @([Diagnostics.Process]::GetProcessesByName($name))
                $candidates += @([Diagnostics.Process]::GetProcessesByName($target.exeName))
            }
        } catch { continue }
        foreach ($candidate in $candidates) {
            try {
                $processId = $candidate.Id
                if ($seen.ContainsKey($processId)) { continue }
                $info = [GsmProcessPrivileges]::Read($processId)
                $exeName = $info.ExeName
                if ($exeName -ine $target.exeName) { continue }
                $seen[$processId] = $true
                $records += @{ pid = $processId; exeName = $exeName; startedAt = $info.StartedAt; elevated = $info.Elevated }
            } catch {
                # The game may exit or deny access while being queried.
            } finally { $candidate.Dispose() }
        }
    }
}
@{ gsmElevated = $gsm.Elevated; processes = @($records) } | ConvertTo-Json -Depth 4 -Compress
`;
    const { stdout } = await execFileAsync(
        getWindowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'),
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
        { windowsHide: true, timeout: 8_000, maxBuffer: 256 * 1024 },
    );
    const result = JSON.parse(stdout.replace(/^\uFEFF/, '').trim()) as ProcessPrivilegeResult;
    if (typeof result.gsmElevated !== 'boolean' && result.gsmElevated !== null) throw new Error('Invalid GSM token result.');
    if (!Array.isArray(result.processes)) throw new Error('Invalid game token results.');
    result.processes = result.processes.filter(value => value && Number.isSafeInteger(value.pid) && value.pid > 0 &&
        typeof value.exeName === 'string' && typeof value.startedAt === 'string' &&
        (typeof value.elevated === 'boolean' || value.elevated === null));
    return result;
}
