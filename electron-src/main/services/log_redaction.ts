import { isIP } from 'node:net';
import * as os from 'node:os';

export interface LogRedactionContext {
    homePaths?: string[];
    usernames?: string[];
    hostnames?: string[];
}

function getLocalContext(): LogRedactionContext {
    const homePaths = [os.homedir(), process.env.USERPROFILE, process.env.HOME];
    const usernames = [process.env.USERNAME, process.env.USER, process.env.LOGNAME];
    try {
        const user = os.userInfo();
        homePaths.push(user.homedir);
        usernames.push(user.username);
    } catch {
        // Some environments do not have a passwd entry; use the environment instead.
    }
    return {
        homePaths: homePaths.filter((value): value is string => Boolean(value)),
        usernames: usernames.filter((value): value is string => Boolean(value)),
        hostnames: [os.hostname(), process.env.COMPUTERNAME].filter((value): value is string => Boolean(value)),
    };
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function encodedForms(value: string): string[] {
    return [value, JSON.stringify(value).slice(1, -1), encodeURI(value), encodeURIComponent(value)];
}

function literalPattern(values: string[], boundary: boolean): RegExp | null {
    const alternatives = [...new Set(values.filter((value) => value.trim().length > 0))]
        .sort((left, right) => right.length - left.length)
        .map(escapeRegExp);
    if (alternatives.length === 0) return null;
    const pattern = `(?:${alternatives.join('|')})`;
    return new RegExp(boundary ? `(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])` : pattern, 'giu');
}

// Match the field name as well as its complete quoted value (JSON, Python repr,
// dataclass dumps, INI and environment variables), including escaped quotes.
const PRIVATE_FIELD = /((?<![\w])['"]?(?:[\w.-]*(?:password|passwd|passphrase|api[ _-]?key|token|secret|cookie|user[ _-]?name|e[ _-]?mail|authorization|credential|client[_-]?id|session[_-]?id)|pwd|login|user)['"]?\s*[:=]\s*)("(?:\\(?:[\s\S]|$)|[^"\\])*(?:"|$)|'(?:\\(?:[\s\S]|$)|[^'\\])*(?:'|$)|[^\s,;&}\])]+)/gi;

/** Redact exported copies only. This is pattern-based, not a guarantee for arbitrary free text. */
export function createLogRedactor(context: LogRedactionContext = getLocalContext()): (text: string) => string {
    const homes = literalPattern((context.homePaths ?? [])
        .filter((home) => home.length > 1 && !/^[a-z]:[\\/]?$/i.test(home))
        .flatMap((home) => [home, home.replace(/\\/g, '/'), home.replace(/\//g, '\\')].flatMap(encodedForms)), false);
    const users = literalPattern((context.usernames ?? []).flatMap(encodedForms), true);
    const hosts = literalPattern((context.hostnames ?? []).flatMap(encodedForms), true);

    const redact = (text: string, depth = 0): string => {
        let result = text;
        // JSON log messages can themselves contain serialized config/HTTP data.
        // Sanitize string contents before re-encoding them, so escaped keys cannot bypass redaction.
        if (result.includes('\\')) {
            result = result.replace(/"(?:\\[\s\S]|[^"\\])*"/g, (literal) => {
                if (!literal.includes('\\')) return literal;
                let value: string;
                try {
                    value = JSON.parse(literal);
                } catch {
                    return literal;
                }
                if (depth >= 4) return '"[REDACTED]"';
                const sanitized = redact(value, depth + 1);
                return sanitized === value ? literal : JSON.stringify(sanitized);
            });
        }
        if (homes) result = result.replace(homes, '[HOME]');

        // Also cover old logs from other accounts, machines and operating systems.
        result = result
            .replace(/\b[a-z]:[\\/]+(?:Users|Documents and Settings)[\\/]+[^\\/\r\n"'<>|]+/gi, '[HOME]')
            .replace(/\/(?:home|Users)\/[^/\\\r\n"'<>|]+/g, '[HOME]')
            .replace(/(?:[a-z](?::|%3a)(?:%5c|%2f)+(?:Users|Documents%20and%20Settings)|%2f(?:home|Users))(?:%5c|%2f)+(?:(?!%2f|%5c)[^\s"'<>])+/gi, '[HOME]')
            .replace(/(\b[a-z][a-z\d+.-]*:\/\/)[^\s/]+@/gi, '$1[REDACTED]@')
            .replace(/(\b(?:Authorization|Proxy-Authorization|Cookie|Set-Cookie)[ \t]*:[ \t]*)[^\r\n]+/gi, '$1[REDACTED]')
            .replace(PRIVATE_FIELD, (_match, prefix: string, value: string) => {
                const quote = value.startsWith('"') || value.startsWith("'") ? value[0] : '';
                return `${prefix}${quote}[REDACTED]${quote}`;
            })
            .replace(/([?&](?:key|sig|signature|code|auth|session|credential)\s*=)[^&\s#"'<>]+/gi, '$1[REDACTED]')
            .replace(/\b(Bearer|Basic)\s+[a-z\d._~+\/-]+=*/gi, '$1 [REDACTED]')
            .replace(/\b(?:sk-[a-z\d_-]{12,}|AIza[a-z\d_-]{20,}|gh[pousr]_[a-z\d_]{20,}|github_pat_[a-z\d_]{20,}|eyJ[a-z\d_-]+\.[a-z\d_-]+\.[a-z\d_-]+)\b/gi, '[REDACTED]')
            .replace(/[a-z\d.!#$%&'*+/=?^_`{|}~-]+(?:@|%40)(?:[a-z\d-]+\.)+[a-z]{2,63}/gi, '[EMAIL]')
            .replace(/(?<![\w:])(?:[a-f\d]*:){2,}[a-f\d.]*(?:%[\w.-]+)?/gi, (address) => {
                if (!isIP(address) || address === '::1' || address === '::' || /^::ffff:127\./i.test(address)) return address;
                return '[IP]';
            })
            .replace(/\b(?:[a-f\d]{2}[:-]){5}[a-f\d]{2}\b/gi, '[MAC]')
            .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (address) => {
                if (!isIP(address) || address.startsWith('127.') || address === '0.0.0.0') return address;
                return '[IP]';
            });

        if (hosts) result = result.replace(hosts, '[HOST]');
        if (users) result = result.replace(users, '[USER]');
        return result;
    };
    return (text) => redact(text);
}
