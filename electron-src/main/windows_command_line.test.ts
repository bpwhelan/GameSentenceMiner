import { describe, expect, it } from 'vitest';
import {
    buildWindowsElevationCommand,
    quoteWindowsArgument,
    splitWindowsCommandLine,
} from './windows_command_line.js';

describe('Windows command lines', () => {
    it.each([
        ['', []],
        ['  \t ', []],
        [String.raw`C:\Users\Sam\obs64.exe --portable`, [String.raw`C:\Users\Sam\obs64.exe`, '--portable']],
        [String.raw`--profile="Sam's $1 [GSM]" --collection="日本語 game"`, ["--profile=Sam's $1 [GSM]", '--collection=日本語 game']],
        [String.raw`"" "C:\Users\Naicha\"file" "C:\Users\space name\\"`, ['', 'C:\\Users\\Naicha"file', 'C:\\Users\\space name\\']],
        [String.raw`a\\\b d"e f"g h`, [String.raw`a\\\b`, 'de fg', 'h']],
        [String.raw`a\\\"b c d`, [String.raw`a\"b`, 'c', 'd']],
        [String.raw`a\\\\"b c" d e`, [String.raw`a\\b c`, 'd', 'e']],
        [String.raw`"C:\Users\%TEMP% & (1) [GSM]\obs64.exe"`, [String.raw`C:\Users\%TEMP% & (1) [GSM]\obs64.exe`]],
        [String.raw`"\\server\share name\obs64.exe"`, [String.raw`\\server\share name\obs64.exe`]],
    ] as [string, string[]][])('preserves arguments in %j', (command, expected) => {
        expect(splitWindowsCommandLine(command)).toEqual(expected);
    });

    it.each([
        ['', '""'],
        [String.raw`C:\Users\Sam\GSM`, String.raw`C:\Users\Sam\GSM`],
        ['C:\\Users\\space name\\', '"C:\\Users\\space name\\\\"'],
        ['a"b', String.raw`"a\"b"`],
        ['a\\"b', String.raw`"a\\\"b"`],
    ])('quotes %j for Windows argument parsing', (value, expected) => {
        expect(quoteWindowsArgument(value)).toBe(expected);
    });

    it('preserves paths through both PowerShell literals and Windows argument quoting for elevation', () => {
        expect(buildWindowsElevationCommand(
            String.raw`C:\Users\O'Brien $env:TEMP\GSM.exe`,
            [String.raw`C:\Users\Sam %TEMP% & 日本語\app`, '--name=a"b', 'C:\\trailing space\\', ''],
        )).toBe(
            String.raw`Start-Process -FilePath 'C:\Users\O''Brien $env:TEMP\GSM.exe' -ArgumentList '"C:\Users\Sam %TEMP% & 日本語\app" "--name=a\"b" "C:\trailing space\\" ""' -Verb RunAs`,
        );
    });
});
