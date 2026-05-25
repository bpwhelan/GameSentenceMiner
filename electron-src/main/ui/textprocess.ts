import { spawn } from 'child_process';
import { ipcMain, shell } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { getPythonPath } from '../store.js';
import { BASE_DIR, getGSMBaseDir, getSanitizedPythonEnv } from '../util.js';
import { sendReloadSettings } from '../main.js';
import { getLatestTextProcessingInput } from '../services/latest_text.js';

const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const CUSTOM_PYTHON_SCRIPT_FILENAME = 'Text_Processing.py';
const CUSTOM_PYTHON_SCRIPT_PATH = path.join(BASE_DIR, CUSTOM_PYTHON_SCRIPT_FILENAME);
const CUSTOM_PYTHON_PREVIEW_MODE = 'preview-custom-python';
const CUSTOM_PYTHON_PREVIEW_TIMEOUT_MS = 3000;
const CUSTOM_PYTHON_PREVIEW_STDOUT_LIMIT = 1024 * 1024;
const CUSTOM_PYTHON_PREVIEW_STDERR_LIMIT = 64 * 1024;
const CUSTOM_PYTHON_SCRIPT_TEMPLATE = `"""Custom Python text processing for GameSentenceMiner.

Edit filter() to transform captured text after String Replacement runs.
"""


def filter(s: str) -> str:
    return s
`;

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

interface TextProcessingIpcResult {
    success: boolean;
    created?: boolean;
    error?: string;
}

interface CustomPythonPreviewResult {
    result: string;
    error?: string;
}

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

    ipcMain.handle('textprocess.preview', async (_, payload: { text: string; config: TextProcessingConfig }) => {
        // Preview is handled client-side for responsiveness
        // This endpoint is reserved for future server-side preview if needed
        return { result: payload.text };
    });

    ipcMain.handle('textprocess.openCustomPythonScript', async (): Promise<TextProcessingIpcResult> => {
        try {
            fs.mkdirSync(BASE_DIR, { recursive: true });
            const created = !fs.existsSync(CUSTOM_PYTHON_SCRIPT_PATH);
            if (created) {
                fs.writeFileSync(CUSTOM_PYTHON_SCRIPT_PATH, CUSTOM_PYTHON_SCRIPT_TEMPLATE, 'utf-8');
            }

            const openError = await shell.openPath(CUSTOM_PYTHON_SCRIPT_PATH);
            if (openError) {
                return { success: false, error: openError };
            }
            return { success: true, created };
        } catch (error: any) {
            return { success: false, error: error?.message || String(error) };
        }
    });

    ipcMain.handle(
        'textprocess.previewCustomPythonScript',
        async (_, payload: { text?: string }): Promise<CustomPythonPreviewResult> => {
            const text = typeof payload?.text === 'string' ? payload.text : '';
            return previewCustomPythonScript(text);
        }
    );

    ipcMain.handle('textprocess.latestText', async () => getLatestTextProcessingInput());
}

function previewCustomPythonScript(text: string): Promise<CustomPythonPreviewResult> {
    return new Promise((resolve) => {
        const proc = spawn(
            getPythonPath(),
            ['-m', 'GameSentenceMiner.util.text_processing', CUSTOM_PYTHON_PREVIEW_MODE],
            {
                cwd: getGSMBaseDir(),
                env: getSanitizedPythonEnv(),
                stdio: ['pipe', 'pipe', 'pipe'],
            }
        );

        let stdout = '';
        let stderr = '';
        let settled = false;
        let timeout: ReturnType<typeof setTimeout> | null = null;

        const finish = (result: CustomPythonPreviewResult) => {
            if (settled) {
                return;
            }
            settled = true;
            if (timeout) {
                clearTimeout(timeout);
            }
            resolve(result);
        };

        timeout = setTimeout(() => {
            proc.kill();
            finish({
                result: text,
                error: `Custom Python preview timed out after ${CUSTOM_PYTHON_PREVIEW_TIMEOUT_MS}ms`,
            });
        }, CUSTOM_PYTHON_PREVIEW_TIMEOUT_MS);

        proc.stdout.setEncoding('utf-8');
        proc.stdout.on('data', (chunk: string) => {
            if (stdout.length + chunk.length > CUSTOM_PYTHON_PREVIEW_STDOUT_LIMIT) {
                proc.kill();
                finish({
                    result: text,
                    error: `Custom Python preview output exceeded ${CUSTOM_PYTHON_PREVIEW_STDOUT_LIMIT} bytes`,
                });
                return;
            }
            stdout += chunk;
        });

        proc.stderr.setEncoding('utf-8');
        proc.stderr.on('data', (chunk: string) => {
            stderr = `${stderr}${chunk}`.slice(0, CUSTOM_PYTHON_PREVIEW_STDERR_LIMIT);
        });

        proc.on('error', (error) => {
            finish({ result: text, error: error.message });
        });

        proc.on('close', (code) => {
            const trimmedError = stderr.trim();
            if (code === 0) {
                finish({ result: stdout, error: trimmedError || undefined });
                return;
            }

            const error = trimmedError || `Custom Python preview exited with code ${code}`;
            finish({ result: text, error });
        });

        proc.stdin.end(text, 'utf-8');
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
