import log from 'electron-log/main.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stripVTControlCharacters } from 'node:util';

const MAX_LOG_BYTES = 5 * 1024 * 1024;
const LOG_BACKUPS = 5;
let processLogger: ReturnType<typeof log.create> | null = null;

/** The desktop owns these files; Python uses separate component logs. */
export function rotateLogFile(filePath: string, backupCount = LOG_BACKUPS): void {
    const history = path.join(path.dirname(filePath), 'history');
    fs.mkdirSync(history, { recursive: true });
    for (let index = backupCount; index > 0; index--) {
        const source = index === 1 ? filePath : path.join(history, `${path.basename(filePath)}.${index - 1}`);
        const destination = path.join(history, `${path.basename(filePath)}.${index}`);
        if (fs.existsSync(source)) fs.renameSync(source, destination);
    }
}

function configureLogFile(logger: typeof log, filePath: string): void {
    logger.transports.file.resolvePathFn = () => filePath;
    logger.transports.file.maxSize = MAX_LOG_BYTES;
    logger.transports.file.level = 'debug';
    logger.transports.file.archiveLogFn = (file) => {
        try {
            rotateLogFile(file.toString());
        } catch {
            // A log viewer can briefly lock a Windows file. Keep the latest
            // diagnostics bounded and retry rotation on the next filled file.
            try {
                const tail = fs.readFileSync(file.path).subarray(-256 * 1024).toString('utf8');
                fs.writeFileSync(file.path, `[Log rotation was blocked; older content trimmed]\n${tail}`, 'utf8');
            } catch {
                // Let electron-log report write errors through its native console.
            }
        }
    };
}

/** Install before loading main.ts so initialization failures are persistent too. */
export function initializeDesktopLogging(baseDirectory: string): void {
    const logs = path.join(baseDirectory, 'logs');
    configureLogFile(log, path.join(logs, 'desktop.log'));
    processLogger = log.create({ logId: 'process-output' });
    configureLogFile(processLogger, path.join(logs, 'process-output.log'));
    processLogger.transports.console.level = false;
    Object.assign(console, log.functions);
    log.info(`Desktop session started (PID ${process.pid})`);
}

/** Keep raw failures even if a child crashes before its Python logger starts. */
export function recordProcessOutput(source: string, stream: string, message: string): void {
    if (!processLogger || !message.trim()) return;
    const text = stripVTControlCharacters(message).trimEnd();
    const bounded = text.length > MAX_LOG_BYTES / 4
        ? `[Oversized process output truncated]\n${text.slice(-MAX_LOG_BYTES / 4)}` : text;
    processLogger.info(`[${source} ${stream}] ${bounded}`);
}
