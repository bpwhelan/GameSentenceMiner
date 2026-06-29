import { ipcMain } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { BASE_DIR, getGSMBaseDir, getSanitizedPythonEnv } from '../util.js';
import { sendReloadSettings } from '../main.js';
import { getLatestTextProcessingInput } from '../services/latest_text.js';
import { getOrInstallPython } from '../python/python_downloader.js';

const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const PREVIEW_TIMEOUT_MS = 10000;

interface TextProcessingConfig {
    string_replacement: {
        enabled: boolean;
        rules: Array<{
            enabled: boolean;
            mode: string;
            find: string;
            replace: string;
            case_sensitive: boolean;
            whole_word: boolean;
        }>;
    };
    processor_order: string[];
    remove_repeated_chars: boolean;
    remove_repeated_chars_config: { repeat_count: number; keep_non_repeated: boolean };
    remove_repeated_lines: boolean;
    remove_repeated_lines_config: { repeat_count: number };
    remove_control_chars: boolean;
    remove_non_japanese: boolean;
    remove_newlines: boolean;
    remove_numbers: boolean;
    remove_english: boolean;
    remove_curly_braces: boolean;
    remove_angle_brackets: boolean;
    extract_bracketed_text: boolean;
    extract_lines: boolean;
    extract_lines_config: { max_lines: number; from_end: boolean };
    unicode_normalize: boolean;
    unicode_normalize_config: { form: string };
}

interface TextProcessingPreviewPayload {
    text: string;
    config: TextProcessingConfig;
}

type TextProcessingPreviewResult =
    | { success: true; result: string }
    | { success: false; error: string };

function readGSMConfig(): Record<string, any> {
    if (!fs.existsSync(CONFIG_PATH)) {
        return {};
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf-8');
    return JSON.parse(raw);
}

function writeGSMConfig(config: Record<string, any>): void {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 4), 'utf-8');
}

function getActiveProfileConfig(gsmConfig: Record<string, any>): Record<string, any> | null {
    const currentProfile = gsmConfig.current_profile;
    const configs = gsmConfig.configs;
    if (!configs || !currentProfile || !configs[currentProfile]) {
        return null;
    }
    return configs[currentProfile];
}

export function registerTextProcessIPC(): void {
    ipcMain.handle('textprocess.load', async () => {
        try {
            const gsmConfig = readGSMConfig();
            const profile = getActiveProfileConfig(gsmConfig);
            if (!profile) {
                return getDefaultTextProcessing();
            }
            return profile.text_processing || getDefaultTextProcessing();
        } catch (error) {
            console.error('Failed to load text processing config:', error);
            return getDefaultTextProcessing();
        }
    });

    ipcMain.handle('textprocess.save', async (_, config: TextProcessingConfig) => {
        try {
            const gsmConfig = readGSMConfig();
            const profile = getActiveProfileConfig(gsmConfig);
            if (!profile) {
                return { success: false, error: 'No active profile found' };
            }
            profile.text_processing = config;
            writeGSMConfig(gsmConfig);
            sendReloadSettings();
            return { success: true };
        } catch (error: any) {
            console.error('Failed to save text processing config:', error);
            return { success: false, error: error?.message || String(error) };
        }
    });

    ipcMain.handle(
        'textprocess.preview',
        async (_, payload: TextProcessingPreviewPayload): Promise<TextProcessingPreviewResult> => {
            try {
                const pythonPath = await getOrInstallPython();
                const result = await runTextProcessingPreview(pythonPath, payload);
                return { success: true, result };
            } catch (error: any) {
                console.error('Failed to preview text processing config:', error);
                return { success: false, error: error?.message || String(error) };
            }
        }
    );

    ipcMain.handle('textprocess.latestText', async () => getLatestTextProcessingInput());
}

export function parseTextProcessingPreviewOutput(stdout: string): string {
    const lines = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .reverse();

    for (const line of lines) {
        try {
            const parsed = JSON.parse(line);
            if (parsed && typeof parsed.result === 'string') {
                return parsed.result;
            }
        } catch {
            // Python logging can write startup lines before the JSON response.
        }
    }

    throw new Error('Python text processing preview did not return JSON output');
}

export function runTextProcessingPreview(
    pythonPath: string,
    payload: TextProcessingPreviewPayload,
    timeoutMs: number = PREVIEW_TIMEOUT_MS
): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(
            pythonPath,
            ['-m', 'GameSentenceMiner.util.text_processing', '--preview-json'],
            {
                cwd: getGSMBaseDir(),
                env: {
                    ...getSanitizedPythonEnv(),
                    GSM_ELECTRON: '1',
                },
                stdio: ['pipe', 'pipe', 'pipe'],
                windowsHide: true,
            }
        );

        let stdout = '';
        let stderr = '';
        let settled = false;

        const finish = (fn: () => void) => {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timeout);
            fn();
        };

        const timeout = setTimeout(() => {
            child.kill();
            finish(() => reject(new Error('Python text processing preview timed out')));
        }, timeoutMs);

        child.stdout?.on('data', (data) => {
            stdout += data.toString('utf8');
        });

        child.stderr?.on('data', (data) => {
            stderr += data.toString('utf8');
        });

        child.on('error', (error) => {
            finish(() => reject(error));
        });

        child.on('close', (code) => {
            finish(() => {
                if (code !== 0) {
                    reject(new Error(stderr.trim() || `Python text processing preview exited with code ${code}`));
                    return;
                }

                try {
                    resolve(parseTextProcessingPreviewOutput(stdout));
                } catch (error) {
                    reject(error);
                }
            });
        });

        child.stdin?.end(JSON.stringify(payload), 'utf8');
    });
}

function getDefaultTextProcessing(): TextProcessingConfig {
    return {
        string_replacement: { enabled: false, rules: [] },
        processor_order: [
            'string_replacement',
            'remove_repeated_chars',
            'remove_repeated_lines',
            'remove_control_chars',
            'remove_non_japanese',
            'remove_newlines',
            'remove_numbers',
            'remove_english',
            'remove_curly_braces',
            'remove_angle_brackets',
            'extract_bracketed_text',
            'extract_lines',
            'unicode_normalize',
        ],
        remove_repeated_chars: false,
        remove_repeated_chars_config: { repeat_count: 1, keep_non_repeated: true },
        remove_repeated_lines: false,
        remove_repeated_lines_config: { repeat_count: 1 },
        remove_control_chars: false,
        remove_non_japanese: false,
        remove_newlines: false,
        remove_numbers: false,
        remove_english: false,
        remove_curly_braces: false,
        remove_angle_brackets: false,
        extract_bracketed_text: false,
        extract_lines: false,
        extract_lines_config: { max_lines: 3, from_end: true },
        unicode_normalize: false,
        unicode_normalize_config: { form: 'NFKC' },
    };
}
