#!/usr/bin/env node

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import process from 'node:process';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(SCRIPT_DIR, '..');
const DEFAULT_CONVERTER_MODULE = path.join(
    REPO_ROOT,
    'dist',
    'main',
    'features',
    'hoshidicts',
    'yomitan_backup.js',
);
const FIXTURES = new Set(['term-heavy', 'media-heavy', 'interleaved', 'mixed']);
const MIB = 1024 * 1024;
const DEFAULT_SIZE_BYTES = 64 * MIB;
const NATIVE_IMPORT_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_CHILD_OUTPUT_BYTES = MIB;
const RSS_SAMPLE_INTERVAL_MS = 50;

const activeChildren = new Set();
let benchmarkRoot = null;
let originalTempEnvironment = null;
let stopping = false;

function usage() {
    return `Benchmark GSM's Yomitan backup-to-ZIP conversion.

Usage:
  node scripts/benchmark-yomitan-backup-conversion.mjs [options]

Input (choose at most one):
  --input PATH              Benchmark a real Yomitan dictionary backup.
  --fixture NAME            term-heavy, media-heavy, interleaved, or mixed
                            (default: mixed).

Fixture options:
  --size SIZE               Approximate generated input size. Bare numbers are
                            MiB; suffixes B, KiB, MiB, and GiB are accepted
                            (default: 64MiB).
  --seed INTEGER            Deterministic unsigned 32-bit seed (default: 549).

Benchmark options:
  --runs INTEGER            Measured runs (default: 3).
  --warmup INTEGER          Unreported warmup runs (default: 1).
  --converter-module PATH   Load a prebuilt converter module instead of the
                            current worktree's dist module. Custom modules are
                            used as-is and are not rebuilt.
  --native-importer PATH    Also time GSM's input-server executable using its
                            hoshidicts-import command for every generated ZIP.
  --skip-build              Reuse dist/ instead of running npm run build:main.
  -h, --help                Show this help.

Successful benchmark runs print one JSON document to stdout. Progress and build
output go to stderr. Generated inputs, converted ZIPs, and native-import output
are created under the OS temporary directory and removed on success or failure.

Examples:
  node scripts/benchmark-yomitan-backup-conversion.mjs \\
    --fixture interleaved --size 256MiB --runs 5 --warmup 1
  node scripts/benchmark-yomitan-backup-conversion.mjs \\
    --input /path/to/yomitan-backup.json --runs 3
  node scripts/benchmark-yomitan-backup-conversion.mjs \\
    --converter-module /path/to/baseline/dist/main/features/hoshidicts/yomitan_backup.js \\
    --input /path/to/yomitan-backup.json
  node scripts/benchmark-yomitan-backup-conversion.mjs \\
    --fixture mixed --native-importer /path/to/GameSentenceMiner-InputServer
`;
}

function readOptionValue(argv, index, name) {
    const argument = argv[index];
    const prefix = `${name}=`;
    if (argument.startsWith(prefix)) {
        return { value: argument.slice(prefix.length), nextIndex: index };
    }
    if (index + 1 >= argv.length) {
        throw new Error(`${name} requires a value.`);
    }
    return { value: argv[index + 1], nextIndex: index + 1 };
}

function parseInteger(value, name, minimum, maximum) {
    if (!/^\d+$/u.test(value)) {
        throw new Error(`${name} must be an integer.`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
        throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
    }
    return parsed;
}

function parseSize(value) {
    const match = /^(\d+(?:\.\d+)?)\s*(b|kib|mib|gib|kb|mb|gb)?$/iu.exec(value);
    if (!match) {
        throw new Error('--size must be a number with an optional B, KiB, MiB, or GiB suffix.');
    }
    const units = {
        b: 1,
        kb: 1000,
        kib: 1024,
        mb: 1000 ** 2,
        mib: 1024 ** 2,
        gb: 1000 ** 3,
        gib: 1024 ** 3,
    };
    const multiplier = match[2] ? units[match[2].toLowerCase()] : MIB;
    const bytes = Math.round(Number(match[1]) * multiplier);
    if (!Number.isSafeInteger(bytes) || bytes <= 0) {
        throw new Error('--size must resolve to a positive safe integer number of bytes.');
    }
    return bytes;
}

function parseArgs(argv) {
    const options = {
        input: null,
        fixture: 'mixed',
        fixtureSpecified: false,
        sizeBytes: DEFAULT_SIZE_BYTES,
        seed: 549,
        runs: 3,
        warmup: 1,
        converterModule: DEFAULT_CONVERTER_MODULE,
        converterModuleSpecified: false,
        nativeImporter: null,
        skipBuild: false,
        help: false,
    };
    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];
        if (argument === '-h' || argument === '--help') {
            options.help = true;
            continue;
        }
        if (argument === '--skip-build') {
            options.skipBuild = true;
            continue;
        }
        const matchedName = [
            '--input',
            '--fixture',
            '--size',
            '--seed',
            '--runs',
            '--warmup',
            '--converter-module',
            '--native-importer',
        ].find((name) => argument === name || argument.startsWith(`${name}=`));
        if (!matchedName) {
            throw new Error(`Unknown option: ${argument}`);
        }
        const { value, nextIndex } = readOptionValue(argv, index, matchedName);
        index = nextIndex;
        switch (matchedName) {
            case '--input':
                options.input = path.resolve(value);
                break;
            case '--fixture':
                options.fixture = value;
                options.fixtureSpecified = true;
                break;
            case '--size':
                options.sizeBytes = parseSize(value);
                break;
            case '--seed':
                options.seed = parseInteger(value, '--seed', 0, 0xffff_ffff);
                break;
            case '--runs':
                options.runs = parseInteger(value, '--runs', 1, 1000);
                break;
            case '--warmup':
                options.warmup = parseInteger(value, '--warmup', 0, 1000);
                break;
            case '--converter-module':
                options.converterModule = path.resolve(value);
                options.converterModuleSpecified = true;
                break;
            case '--native-importer':
                options.nativeImporter = path.resolve(value);
                break;
        }
    }
    if (options.input && options.fixtureSpecified) {
        throw new Error('--input and --fixture cannot be used together.');
    }
    if (!FIXTURES.has(options.fixture)) {
        throw new Error(`Unknown fixture: ${options.fixture}.`);
    }
    return options;
}

class ChunkedJsonWriter {
    constructor(handle) {
        this.handle = handle;
        this.chunks = [];
        this.bufferedBytes = 0;
        this.writtenBytes = 0;
        this.closed = false;
    }

    get bytes() {
        return this.writtenBytes + this.bufferedBytes;
    }

    append(value) {
        const byteLength = Buffer.byteLength(value);
        this.chunks.push(value);
        this.bufferedBytes += byteLength;
        return this.bufferedBytes >= MIB ? this.flush() : null;
    }

    async flush() {
        if (this.chunks.length === 0) return;
        const value = this.chunks.length === 1 ? this.chunks[0] : this.chunks.join('');
        const byteLength = this.bufferedBytes;
        this.chunks = [];
        this.bufferedBytes = 0;
        await this.handle.writeFile(value, 'utf8');
        this.writtenBytes += byteLength;
    }

    async close() {
        if (this.closed) return;
        this.closed = true;
        try {
            await this.flush();
        } finally {
            await this.handle.close();
        }
    }
}

async function append(writer, value) {
    const pending = writer.append(value);
    if (pending) await pending;
}

function fixtureTitles(fixture) {
    const count = fixture === 'interleaved' ? 17 : fixture === 'mixed' ? 4 : 1;
    return Array.from(
        { length: count },
        (_, index) => `GSM Benchmark ${String(index + 1).padStart(2, '0')}`,
    );
}

function rowToken(index, seed) {
    return (Math.imul(index + 1, 0x9e37_79b1) ^ seed).toString(36);
}

function termRow(index, titles, seed) {
    const token = rowToken(index, seed);
    return {
        dictionary: titles[index % titles.length],
        expression: `語${index.toString(36)}`,
        reading: `ご${index.toString(36)}`,
        definitionTags: 'n',
        rules: '',
        score: 0,
        glossary: [`deterministic benchmark definition ${token} ${token}`],
        sequence: index,
        termTags: '',
    };
}

function termMetaRow(index, titles, seed) {
    return {
        dictionary: titles[index % titles.length],
        expression: `語${rowToken(index, seed)}`,
        mode: 'freq',
        data: (index % 1_000_000) + 1,
    };
}

function kanjiRow(index, titles, seed) {
    const token = rowToken(index, seed);
    return {
        dictionary: titles[index % titles.length],
        character: String.fromCodePoint(0x4e00 + (index % 2_000)),
        onyomi: 'ゴ',
        kunyomi: 'ご',
        tags: '',
        meanings: [`benchmark ${token}`],
        stats: {},
    };
}

function deterministicBytes(length, seed, index) {
    const result = Buffer.allocUnsafe(length);
    let state = (seed ^ Math.imul(index + 1, 0x85eb_ca6b)) >>> 0;
    for (let offset = 0; offset < length; offset += 4) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        result[offset] = state & 0xff;
        if (offset + 1 < length) result[offset + 1] = (state >>> 8) & 0xff;
        if (offset + 2 < length) result[offset + 2] = (state >>> 16) & 0xff;
        if (offset + 3 < length) result[offset + 3] = (state >>> 24) & 0xff;
    }
    return result;
}

function mediaRow(index, titles, seed) {
    const content = deterministicBytes(48 * 1024, seed, index);
    return {
        dictionary: titles[index % titles.length],
        path: `media/${index.toString(36).padStart(8, '0')}.bin`,
        content: content.toString('base64'),
    };
}

async function writeTable(writer, tableName, targetBytes, rowFactory, counts, countKey) {
    await append(writer, `,{"tableName":${JSON.stringify(tableName)},"inbound":true,"rows":[`);
    let index = 0;
    do {
        const prefix = index === 0 ? '' : ',';
        await append(writer, prefix + JSON.stringify(rowFactory(index)));
        index += 1;
    } while (writer.bytes < targetBytes || index < 1);
    counts[countKey] += index;
    await append(writer, ']}');
}

async function generateFixture(filePath, fixture, targetBytes, seed) {
    const titles = fixtureTitles(fixture);
    const summaries = titles.map((title) => ({
        title,
        revision: 'benchmark-1',
        sequenced: false,
        sourceLanguage: 'ja',
        targetLanguage: 'en',
    }));
    const counts = {
        dictionaries: titles.length,
        termRows: 0,
        termMetaRows: 0,
        kanjiRows: 0,
        mediaRows: 0,
    };
    const handle = await fsp.open(filePath, 'wx');
    const writer = new ChunkedJsonWriter(handle);
    try {
        await append(
            writer,
            '{"formatName":"dexie","formatVersion":1,"data":' +
                '{"databaseName":"dict","databaseVersion":60,"tables":[],"data":[' +
                '{"tableName":"dictionaries","inbound":true,"rows":' +
                JSON.stringify(summaries) +
                '}',
        );
        if (fixture === 'term-heavy' || fixture === 'interleaved') {
            await writeTable(
                writer,
                'terms',
                targetBytes,
                (index) => termRow(index, titles, seed),
                counts,
                'termRows',
            );
        } else if (fixture === 'media-heavy') {
            await writeTable(
                writer,
                'terms',
                0,
                (index) => termRow(index, titles, seed),
                counts,
                'termRows',
            );
            await writeTable(
                writer,
                'media',
                targetBytes,
                (index) => mediaRow(index, titles, seed),
                counts,
                'mediaRows',
            );
        } else {
            await writeTable(
                writer,
                'terms',
                targetBytes * 0.5,
                (index) => termRow(index, titles, seed),
                counts,
                'termRows',
            );
            await writeTable(
                writer,
                'termMeta',
                targetBytes * 0.65,
                (index) => termMetaRow(index, titles, seed),
                counts,
                'termMetaRows',
            );
            await writeTable(
                writer,
                'kanji',
                targetBytes * 0.8,
                (index) => kanjiRow(index, titles, seed),
                counts,
                'kanjiRows',
            );
            await writeTable(
                writer,
                'media',
                targetBytes,
                (index) => mediaRow(index, titles, seed),
                counts,
                'mediaRows',
            );
        }
        await append(writer, ']}}');
    } finally {
        await writer.close();
    }
    return { ...counts, bytes: (await fsp.stat(filePath)).size };
}

function writeChildOutput(chunk) {
    process.stderr.write(chunk);
}

async function buildMain() {
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const startedAt = performance.now();
    process.stderr.write('[benchmark] building Electron main process...\n');
    await new Promise((resolve, reject) => {
        const child = spawn(command, ['run', 'build:main'], {
            cwd: REPO_ROOT,
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        activeChildren.add(child);
        child.stdout.on('data', writeChildOutput);
        child.stderr.on('data', writeChildOutput);
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            activeChildren.delete(child);
            if (code === 0) resolve();
            else reject(new Error(`npm run build:main failed (${signal || `exit ${code}`}).`));
        });
    });
    return performance.now() - startedAt;
}

async function runNativeImporter(executable, archivePath, outputDir) {
    await fsp.mkdir(outputDir, { recursive: true });
    const startedAt = performance.now();
    try {
        const report = await new Promise((resolve, reject) => {
            const child = spawn(
                executable,
                ['hoshidicts-import', '--archive', archivePath, '--output-dir', outputDir],
                {
                    cwd: outputDir,
                    env: process.env,
                    windowsHide: true,
                    stdio: ['ignore', 'pipe', 'pipe'],
                },
            );
            activeChildren.add(child);
            let stdout = '';
            let stderr = '';
            let outputBytes = 0;
            let settled = false;
            const finish = (callback, value) => {
                if (settled) return;
                settled = true;
                clearTimeout(timeout);
                activeChildren.delete(child);
                callback(value);
            };
            const collect = (current, chunk) => {
                outputBytes += chunk.length;
                if (outputBytes > MAX_CHILD_OUTPUT_BYTES) {
                    child.kill();
                    finish(reject, new Error('Native importer output exceeded 1 MiB.'));
                    return current;
                }
                return current + chunk.toString('utf8');
            };
            child.stdout.on('data', (chunk) => {
                stdout = collect(stdout, chunk);
            });
            child.stderr.on('data', (chunk) => {
                stderr = collect(stderr, chunk);
            });
            child.once('error', (error) => finish(reject, error));
            child.once('exit', (code, signal) => {
                if (settled) return;
                if (code !== 0) {
                    finish(
                        reject,
                        new Error(
                            stderr.trim() ||
                                `Native importer failed (${signal || `exit ${code}`}).`,
                        ),
                    );
                    return;
                }
                try {
                    const line = stdout
                        .split(/\r?\n/u)
                        .map((value) => value.trim())
                        .filter(Boolean)
                        .at(-1);
                    const parsed = line ? JSON.parse(line) : null;
                    if (!parsed || parsed.success !== true) {
                        throw new Error(parsed?.error || 'Native importer did not report success.');
                    }
                    finish(resolve, parsed);
                } catch (error) {
                    finish(reject, error);
                }
            });
            const timeout = setTimeout(() => {
                child.kill();
                finish(reject, new Error('Native importer timed out after 30 minutes.'));
            }, NATIVE_IMPORT_TIMEOUT_MS);
        });
        return { durationMs: performance.now() - startedAt, report };
    } finally {
        await fsp.rm(outputDir, { recursive: true, force: true });
    }
}

function currentRssBytes() {
    return process.memoryUsage.rss();
}

function redirectTemporaryFiles(root) {
    const keys = ['TMPDIR', 'TMP', 'TEMP'];
    originalTempEnvironment = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) process.env[key] = root;
}

function restoreTemporaryFiles() {
    if (!originalTempEnvironment) return;
    for (const [key, value] of Object.entries(originalTempEnvironment)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
    originalTempEnvironment = null;
}

function rounded(value) {
    return Math.round(value * 1000) / 1000;
}

async function runConversion(
    prepareYomitanDictionaryBackup,
    inputPath,
    nativeImporter,
    runRoot,
    index,
) {
    const startedAt = performance.now();
    const cpuStarted = process.cpuUsage();
    const rssStarted = currentRssBytes();
    let peakRssBytes = rssStarted;
    const sampleRss = () => {
        peakRssBytes = Math.max(peakRssBytes, currentRssBytes());
    };
    const rssTimer = setInterval(sampleRss, RSS_SAMPLE_INTERVAL_MS);
    rssTimer.unref();
    let firstPreparingAt = null;
    let currentZipStartedAt = null;
    let zipMs = 0;
    let archiveBytes = 0;
    let dictionaryCount = 0;
    let nativeImportMs = 0;
    const nativeReports = [];
    let prepared = null;
    try {
        prepared = await prepareYomitanDictionaryBackup(
            inputPath,
            () => {
                const now = performance.now();
                if (firstPreparingAt === null) firstPreparingAt = now;
                currentZipStartedAt = now;
            },
            async (dictionary) => {
                const now = performance.now();
                if (currentZipStartedAt === null) {
                    throw new Error(
                        'Converter prepared a ZIP before reporting its preparing stage.',
                    );
                }
                zipMs += now - currentZipStartedAt;
                currentZipStartedAt = null;
                archiveBytes += (await fsp.stat(dictionary.archivePath)).size;
                dictionaryCount += 1;
                if (nativeImporter) {
                    const outputDir = path.join(runRoot, `native-${index}-${dictionary.current}`);
                    const native = await runNativeImporter(
                        nativeImporter,
                        dictionary.archivePath,
                        outputDir,
                    );
                    nativeImportMs += native.durationMs;
                    nativeReports.push(native.report);
                }
            },
        );
    } finally {
        try {
            await prepared?.cleanup();
        } finally {
            clearInterval(rssTimer);
            sampleRss();
        }
    }
    const finishedAt = performance.now();
    if (firstPreparingAt === null) {
        throw new Error('Converter did not report a preparing stage.');
    }
    const cpu = process.cpuUsage(cpuStarted);
    const totalWallMs = finishedAt - startedAt;
    const processCpuMs = (cpu.user + cpu.system) / 1000;
    const parseAndSpoolMs = firstPreparingAt - startedAt;
    return {
        index,
        stagesMs: {
            parseAndSpool: rounded(parseAndSpoolMs),
            zip: rounded(zipMs),
            conversionToZip: rounded(parseAndSpoolMs + zipMs),
            nativeImport: nativeImporter ? rounded(nativeImportMs) : null,
            totalWall: rounded(totalWallMs),
        },
        processCpu: {
            userMs: rounded(cpu.user / 1000),
            systemMs: rounded(cpu.system / 1000),
            totalMs: rounded(processCpuMs),
            percentOfOneCore: rounded((processCpuMs / totalWallMs) * 100),
        },
        processRss: {
            startBytes: rssStarted,
            peakBytes: peakRssBytes,
        },
        archiveBytes,
        dictionaryCount,
        nativeImportCount: nativeReports.length,
    };
}

function median(sortedValues) {
    const middle = Math.floor(sortedValues.length / 2);
    return sortedValues.length % 2 === 0
        ? (sortedValues[middle - 1] + sortedValues[middle]) / 2
        : sortedValues[middle];
}

function summarize(values) {
    if (values.length === 0) return null;
    const sorted = [...values].sort((left, right) => left - right);
    const p95Index = Math.ceil(sorted.length * 0.95) - 1;
    return {
        min: rounded(sorted[0]),
        median: rounded(median(sorted)),
        mean: rounded(values.reduce((sum, value) => sum + value, 0) / values.length),
        p95: rounded(sorted[Math.max(0, p95Index)]),
        max: rounded(sorted.at(-1)),
    };
}

function commandText(command, args) {
    try {
        return execFileSync(command, args, {
            cwd: REPO_ROOT,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeout: 2000,
        }).trim();
    } catch {
        return null;
    }
}

function runtimeMetadata(converterModule) {
    const cpus = os.cpus();
    const gitStatus = commandText('git', ['status', '--porcelain']);
    return {
        node: process.version,
        v8: process.versions.v8,
        platform: process.platform,
        architecture: process.arch,
        osRelease: os.release(),
        cpuModel: cpus[0]?.model || null,
        logicalCpuCount: cpus.length,
        totalMemoryBytes: os.totalmem(),
        converterModulePath: converterModule,
        gitRevision: commandText('git', ['rev-parse', 'HEAD']),
        gitBranch: commandText('git', ['branch', '--show-current']),
        gitDirty: gitStatus === null ? null : gitStatus !== '',
    };
}

async function validatePath(filePath, label) {
    let stat;
    try {
        stat = await fsp.stat(filePath);
    } catch (error) {
        throw new Error(`${label} does not exist: ${filePath}`, { cause: error });
    }
    if (!stat.isFile()) throw new Error(`${label} is not a file: ${filePath}`);
    return stat;
}

async function runBenchmark(options) {
    let buildMs = null;
    const buildCurrentModule = !options.skipBuild && !options.converterModuleSpecified;
    if (buildCurrentModule) buildMs = await buildMain();
    await validatePath(options.converterModule, 'Compiled converter module');
    if (options.nativeImporter) {
        await validatePath(options.nativeImporter, 'Native importer');
        if (process.platform !== 'win32') {
            await fsp.access(options.nativeImporter, fs.constants.X_OK);
        }
    }

    const converter = await import(
        `${pathToFileURL(options.converterModule).href}?benchmark=${Date.now()}`
    );
    if (typeof converter.prepareYomitanDictionaryBackup !== 'function') {
        throw new Error('Compiled converter does not export prepareYomitanDictionaryBackup().');
    }

    benchmarkRoot = await fsp.mkdtemp(path.join(os.tmpdir(), 'gsm-yomitan-benchmark-'));
    redirectTemporaryFiles(benchmarkRoot);
    let inputPath = options.input;
    let fixtureStats = null;
    if (!inputPath) {
        inputPath = path.join(benchmarkRoot, `${options.fixture}.json`);
        process.stderr.write(
            `[benchmark] generating ${options.fixture} fixture (${options.sizeBytes} requested bytes)...\n`,
        );
        fixtureStats = await generateFixture(
            inputPath,
            options.fixture,
            options.sizeBytes,
            options.seed,
        );
    }
    const inputStat = await validatePath(inputPath, 'Input backup');
    for (let index = 0; index < options.warmup; index += 1) {
        process.stderr.write(`[benchmark] warmup ${index + 1}/${options.warmup}\n`);
        await runConversion(
            converter.prepareYomitanDictionaryBackup,
            inputPath,
            options.nativeImporter,
            benchmarkRoot,
            -(index + 1),
        );
    }
    const runs = [];
    for (let index = 0; index < options.runs; index += 1) {
        process.stderr.write(`[benchmark] measured run ${index + 1}/${options.runs}\n`);
        runs.push(
            await runConversion(
                converter.prepareYomitanDictionaryBackup,
                inputPath,
                options.nativeImporter,
                benchmarkRoot,
                index + 1,
            ),
        );
    }
    const stage = (name) => summarize(runs.map((run) => run.stagesMs[name]));
    return {
        schemaVersion: 1,
        benchmark: 'yomitan-backup-conversion',
        generatedAt: new Date().toISOString(),
        config: {
            runs: options.runs,
            warmup: options.warmup,
            builtMain: buildCurrentModule,
            buildMs: buildMs === null ? null : rounded(buildMs),
            converterModule: options.converterModule,
            nativeImporter: options.nativeImporter,
        },
        input: {
            kind: options.input ? 'real' : 'generated',
            path: options.input,
            fixture: options.input ? null : options.fixture,
            requestedBytes: options.input ? null : options.sizeBytes,
            bytes: inputStat.size,
            seed: options.input ? null : options.seed,
            fixtureStats,
        },
        runtime: runtimeMetadata(options.converterModule),
        measurementNotes: {
            parseAndSpool: 'Elapsed wall time through the first converter preparing callback.',
            zip: 'Sum from each preparing callback through its finalized ZIP callback; the converter also deletes that dictionary spool before this callback.',
            resourceUsage: `CPU and ${RSS_SAMPLE_INTERVAL_MS} ms RSS samples describe each measured run; optional native-importer child resources are excluded.`,
        },
        runs,
        summary: {
            stagesMs: {
                parseAndSpool: stage('parseAndSpool'),
                zip: stage('zip'),
                conversionToZip: stage('conversionToZip'),
                nativeImport: options.nativeImporter ? stage('nativeImport') : null,
                totalWall: stage('totalWall'),
            },
            processCpuMs: summarize(runs.map((run) => run.processCpu.totalMs)),
            processCpuPercentOfOneCore: summarize(
                runs.map((run) => run.processCpu.percentOfOneCore),
            ),
            processRssStartBytes: summarize(runs.map((run) => run.processRss.startBytes)),
            processPeakRssBytes: summarize(runs.map((run) => run.processRss.peakBytes)),
            archiveBytes: summarize(runs.map((run) => run.archiveBytes)),
        },
    };
}

function stop(signal) {
    if (stopping) return;
    stopping = true;
    for (const child of activeChildren) child.kill();
    if (benchmarkRoot) {
        try {
            fs.rmSync(benchmarkRoot, { recursive: true, force: true });
        } catch {
            // The process is terminating; the normal cleanup path is no longer available.
        }
    }
    process.exit(signal === 'SIGINT' ? 130 : 143);
}

process.once('SIGINT', () => stop('SIGINT'));
process.once('SIGTERM', () => stop('SIGTERM'));

async function main() {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        process.stdout.write(usage());
        return;
    }
    let report;
    try {
        report = await runBenchmark(options);
    } finally {
        if (benchmarkRoot) {
            restoreTemporaryFiles();
            await fsp.rm(benchmarkRoot, { recursive: true, force: true });
            benchmarkRoot = null;
        }
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    process.stderr.write(`[benchmark] ${message}\n`);
    process.exitCode = 1;
});
