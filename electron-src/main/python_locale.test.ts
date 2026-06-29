import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import {
    syncPythonDisplayLocale,
    toPythonLocale,
} from './python_locale.js';

describe('Python display locale sync', () => {
    it('maps Electron locale codes to Python config locale codes', () => {
        expect(toPythonLocale('en')).toBe('en_us');
        expect(toPythonLocale('ja')).toBe('ja_jp');
        expect(toPythonLocale('ukr')).toBe('ukr_ua');
        expect(toPythonLocale('zh')).toBe('zh_cn');
        expect(toPythonLocale('ko')).toBe('ko_kr');
        expect(toPythonLocale('es')).toBe('es_es');
        expect(toPythonLocale('unknown')).toBe('en_us');
    });

    it('updates an existing Python config locale without changing other data', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-python-locale-'));
        const configPath = path.join(dir, 'config.json');
        fs.writeFileSync(
            configPath,
            JSON.stringify({
                current_profile: 'Default',
                configs: { Default: { name: 'Default' } },
                locale: 'en_us',
            }),
            'utf-8'
        );

        expect(syncPythonDisplayLocale('ko', configPath)).toBe(true);

        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        expect(config.locale).toBe('ko_kr');
        expect(config.current_profile).toBe('Default');
        expect(config.configs.Default.name).toBe('Default');

        fs.rmSync(dir, { recursive: true, force: true });
    });

    it('does not create a partial Python config when none exists', () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tmp-python-locale-'));
        const configPath = path.join(dir, 'config.json');

        expect(syncPythonDisplayLocale('ukr', configPath)).toBe(false);
        expect(fs.existsSync(configPath)).toBe(false);

        fs.rmSync(dir, { recursive: true, force: true });
    });
});
