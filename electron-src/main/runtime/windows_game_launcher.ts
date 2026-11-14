import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { GameLaunchCommand } from '../services/game_launcher.js';
import { quoteWindowsArgument } from '../windows_command_line.js';
import { getWindowsSystemExecutable } from './windows_tools.js';

const execFileAsync = promisify(execFile);

/** Launch through Explorer's desktop so both the token and environment belong to its user. */
export async function launchGameAsUser(command: GameLaunchCommand): Promise<number> {
    const payload = Buffer.from(JSON.stringify({
        executable: command.executable,
        arguments: command.args.map(quoteWindowsArgument).join(' '),
        cwd: command.cwd,
    }), 'utf8').toString('base64');
    // Shell.Application must come from the desktop view, not the elevated COM client.
    // https://devblogs.microsoft.com/oldnewthing/20131118-00/?p=2643/
    // The normal-user helper confirms Process.Start over a one-use authenticated loopback
    // connection. ShellExecute alone acknowledges dispatch, even when the target cannot start.
    const script = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$requestBase64 = '${payload}'
$listener = $null
$client = $null
$reader = $null
try {
    $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
    $listener.Start(1)
    $port = $listener.LocalEndpoint.Port
    $nonce = [Guid]::NewGuid().ToString('N')
    $userScript = @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('@@REQUEST@@')) | ConvertFrom-Json
$result = @{ nonce = '@@NONCE@@'; pid = 0; error = '' }
try {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = [Security.Principal.WindowsPrincipal]::new($identity)
        if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
            throw 'The desktop launcher is running as administrator. The game was not launched.'
        }
    } finally { $identity.Dispose() }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $request.executable
    $start.Arguments = $request.arguments
    $start.WorkingDirectory = $request.cwd
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $game = [Diagnostics.Process]::Start($start)
    try { $result.pid = $game.Id } finally { $game.Dispose() }
} catch {
    $result.error = $_.Exception.GetBaseException().Message
}
$connection = [Net.Sockets.TcpClient]::new()
try {
    $connection.Connect([Net.IPAddress]::Loopback, @@PORT@@)
    $writer = [IO.StreamWriter]::new($connection.GetStream(), [Text.UTF8Encoding]::new($false))
    try { $writer.WriteLine(($result | ConvertTo-Json -Compress)); $writer.Flush() }
    finally { $writer.Dispose() }
} finally { $connection.Dispose() }
'@
    $userScript = $userScript.Replace('@@REQUEST@@', $requestBase64).Replace('@@NONCE@@', $nonce).Replace('@@PORT@@', [string]$port)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($userScript))
    $powerShell = [IO.Path]::Combine($env:SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    $shell = New-Object -ComObject Shell.Application
    $windows = $shell.Windows()
    $desktopHwnd = 0
    $desktop = $windows.FindWindowSW(0, 0, 8, [ref]$desktopHwnd, 1)
    if ($null -eq $desktop) { throw 'No desktop user is available to launch the game.' }
    $pending = $listener.AcceptTcpClientAsync()
    $desktop.Document.Application.ShellExecute($powerShell, "-NoLogo -NoProfile -NonInteractive -EncodedCommand $encoded", '', 'open', 0)
    if (!$pending.Wait(10000)) { throw 'The desktop launcher did not respond in time.' }
    $client = $pending.Result
    $client.ReceiveTimeout = 2000
    $reader = [IO.StreamReader]::new($client.GetStream(), [Text.Encoding]::UTF8)
    $response = $reader.ReadLine() | ConvertFrom-Json
    if ($response.nonce -cne $nonce) { throw 'Invalid response from the desktop launcher.' }
    if ($response.error) { throw $response.error }
    if ($response.pid -le 0) { throw 'The desktop launcher did not return a game process.' }
    [Console]::WriteLine($response.pid)
} catch {
    [Console]::WriteLine((@{ error = $_.Exception.GetBaseException().Message } | ConvertTo-Json -Compress))
    exit 1
} finally {
    if ($reader) { $reader.Dispose() }
    if ($client) { $client.Dispose() }
    if ($listener) { $listener.Stop() }
}
`;
    let stdout: string;
    try {
        ({ stdout } = await execFileAsync(
            getWindowsSystemExecutable('WindowsPowerShell\\v1.0\\powershell.exe'),
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
            { windowsHide: true, timeout: 15_000, maxBuffer: 256 * 1024 },
        ));
    } catch (error) {
        const failure = error as { stdout?: string; stderr?: string; code?: string | number };
        let message: unknown;
        try { message = JSON.parse(failure.stdout?.trim() ?? '').error; } catch { /* No structured response. */ }
        // Never show PowerShell's CLIXML progress stream or execFile's full command in the UI.
        const plainError = failure.stderr?.replace(/^#< CLIXML\s*/, '').split(/<Objs\b/)[0].trim();
        throw new Error(typeof message === 'string' && message ? message
            : plainError || `Windows game launcher failed (${failure.code ?? 'unknown error'}).`);
    }
    const pid = Number(stdout.trim());
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error('Invalid game process ID from Windows launcher.');
    return pid;
}
