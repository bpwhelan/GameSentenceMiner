import { describe, expect, it } from 'vitest';

import { createLogRedactor } from './log_redaction.js';

const redact = createLogRedactor({
    homePaths: ['C:\\Users\\Alice Smith', '/srv/accounts/Alice Smith'],
    usernames: ['Alice Smith', 'alice'],
    hostnames: ['ALICE-PC'],
});

describe('log export anonymization', () => {
    it('redacts local identities and home paths in plain, JSON and URL forms', () => {
        const result = redact([
            'User Alice Smith on ALICE-PC; alice started OCR; malice is unrelated.',
            String.raw`C:\Users\Alice Smith\AppData\Roaming\GameSentenceMiner\config.json`,
            JSON.stringify({ path: String.raw`C:\Users\Alice Smith\logs\main.log` }),
            'file:///C:/Users/Alice%20Smith/logs/main.log',
            encodeURIComponent('C:\\Users\\Alice Smith\\logs\\main.log'),
            '/srv/accounts/Alice Smith/logs/main.log',
        ].join('\n'));

        expect(result).not.toMatch(/(?<![a-z])alice|Alice%20Smith/i);
        expect(result).toContain('malice is unrelated');
        expect(result).toContain('GameSentenceMiner');
        expect(result).toContain('main.log');
        expect(result).toContain('[HOME]');
        expect(result).toContain('[HOST]');
    });

    it('handles other accounts in Windows, macOS, Linux and escaped paths', () => {
        for (const input of [
            String.raw`C:\Users\Other Person\AppData\main.log`,
            String.raw`D:\\Users\\Other Person\\AppData\\main.log`,
            '/Users/Other Person/Library/main.log',
            '/home/other-person/.config/main.log',
            'file:///C:/Users/Other%20Person/AppData/main.log',
            'C%3A%5CUsers%5COther%20Person%5Cmain.log',
        ]) {
            expect(redact(input)).not.toMatch(/other/i);
            expect(redact(input)).toContain('main.log');
        }
    });

    it.each([
        'password=supersecret',
        'obs_password = "secret with spaces"',
        'Config(open_ai_api_key=\'secret\\\'with-quote\', port=7274)',
        '{"gemini_api_key": "secret\\\"with-quote", "port": 7274}',
        '{"apiKey": "supersecret", "port": 7274}',
        'gsm_cloud_refresh_token: supersecret',
        'tadoku_session_cookie=supersecret',
        'Authorization: Bearer supersecret',
        '{"Authorization": "Basic supersecret"}',
        'Cookie: session=supersecret; private=anothersecret',
        'Set-Cookie: session=supersecret; HttpOnly',
        'https://login:supersecret@example.test/api?api_key=anothersecret&port=7274',
        'https://example.test/api?key=supersecret&signature=anothersecret',
        'username=someone-private email=private@example.test',
        'password="secret with spaces',
    ])('redacts sensitive fields: %s', (input) => {
        const result = redact(input);
        expect(result).not.toMatch(/supersecret|anothersecret|secret with spaces|secret.*with-quote|someone-private|private@example/);
        expect(result).toContain('[REDACTED]');
    });

    it('redacts email addresses, remote IPs, MAC addresses and standalone credentials', () => {
        const result = redact([
            'Contact other.person@example.com or other.person%40example.com',
            'Remote: 192.168.1.25:7274, 203.0.113.8, [2001:db8::abcd]:443, fe80::1234%eth0, 2001:db8:aa:bb:cc:dd:ee:ff',
            'MAC 00:1A:2B:3C:4D:5E',
            'Received Bearer secret-token-value',
            'Key sk-proj-abcdefghijklmnopqrstuvwxyz123456',
            'Token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature',
        ].join('\n'));

        expect(result).not.toMatch(/other.person|192\.168|203\.0|2001:db8|fe80|00:1A|secret-token|sk-proj-|eyJ/);
        expect(result).toContain('[EMAIL]');
        expect(result).toContain('[IP]:7274');
    });

    it('preserves useful diagnostics, game text, versions and loopback endpoints', () => {
        const input = [
            '2026-09-17 12:34:56.789 | ERROR | ConnectionRefusedError: 10061',
            'GSM 2026.9.2; Python 3.13.2; port=7274; timeout=30; tokens=1024',
            'http://127.0.0.1:7274/api http://localhost:8765 http://[::1]:7274',
            'Listening on 0.0.0.0:7274 and [::]:7274',
            'GameSentenceMiner/web/api.py:42 日本語のゲームテキスト',
        ].join('\n');
        expect(redact(input)).toBe(input);
    });

    it('redacts the entire value when a quoted credential is truncated', () => {
        expect(redact('password="secret with spaces')).toBe('password="[REDACTED]"');
        expect(redact("api_key='secret with spaces")).toBe("api_key='[REDACTED]'");
        expect(redact('password="secret with spaces\\')).toBe('password="[REDACTED]"');
    });

    it('redacts credentials inside JSON-encoded log messages', () => {
        let input = JSON.stringify({ api_key: 'a private credential with spaces', port: 7274 });
        for (let depth = 0; depth < 3; depth++) {
            input = JSON.stringify({ message: input });
            const result = redact(input);
            expect(result).not.toContain('a private credential with spaces');
            expect(result).toContain('7274');
        }
    });

    it('treats identity values literally, including regex punctuation and Unicode', () => {
        const customRedact = createLogRedactor({ usernames: ['a.b+test', '利用者'], homePaths: [], hostnames: [] });
        expect(customRedact('a.b+test 利用者 axbbtest')).toBe('[USER] [USER] axbbtest');
    });
});
