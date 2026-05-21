import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const APP_NAME = 'GameSentenceMiner';
export const ELECTRON_TO_PYTHON_LOCALE: Record<string, string> = {
    en: 'en_us',
    ja: 'ja_jp',
    ukr: 'ukr_ua',
    zh: 'zh_cn',
    ko: 'ko_kr',
    es: 'es_es',
};

export function toPythonLocale(locale: string): string {
    const normalized = String(locale || '').trim().toLowerCase();
    return ELECTRON_TO_PYTHON_LOCALE[normalized] || ELECTRON_TO_PYTHON_LOCALE.en;
}

export function getPythonConfigPath(): string {
    const baseDir = process.env.APPDATA
        ? path.join(process.env.APPDATA, APP_NAME)
        : path.join(os.homedir(), '.config', APP_NAME);
    return path.join(baseDir, 'config.json');
}

export function syncPythonDisplayLocale(
    electronLocale: string,
    configPath = getPythonConfigPath()
): boolean {
    if (!fs.existsSync(configPath)) {
        return false;
    }

    let data: unknown;
    try {
        data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (error) {
        console.error(`Failed to read Python config locale from ${configPath}:`, error);
        return false;
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return false;
    }

    const config = data as Record<string, unknown>;
    const nextLocale = toPythonLocale(electronLocale);
    if (config.locale === nextLocale) {
        return false;
    }

    config.locale = nextLocale;
    try {
        fs.writeFileSync(configPath, `${JSON.stringify(config, null, 4)}\n`, 'utf-8');
        return true;
    } catch (error) {
        console.error(`Failed to write Python config locale to ${configPath}:`, error);
        return false;
    }
}
