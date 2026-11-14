// Equal engine, pixels, capture target, and 500 ms sleep between scans.
// Both implementations report total process CPU, not just elapsed inference.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { nativeExecutable, root } from './native-paths.mjs';
if (process.platform !== 'win32') throw Error('This benchmark measures Windows Graphics Capture.');
const directory = path.resolve(process.argv[2] || '.tmp-ocr-benchmark');
fs.mkdirSync(directory, { recursive: true });
const run = (file, args, env = {}, log) => new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...env }, stdio: log ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    const output = log ? fs.createWriteStream(log) : null;
    if (output) { child.stdout.pipe(output); child.stderr.pipe(output); }
    child.on('error', reject);
    child.on('exit', code => { output?.end(); code === 0 ? resolve() : reject(Error(`${file} exited ${code}; see ${log || 'output'}`)); });
});
const cargo = ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml', '--target-dir', 'src-tauri/target/native-dev'];
await run('cargo', [...cargo, '--no-run']);
const image = path.join(directory, 'game.png');
if (!fs.existsSync(image)) await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', '5', '-i', 'tests/assets/Replay_2025-12-19_22-24-52.mov', '-frames:v', '1', '-y', image]);
const fixtureResult = path.join(directory, 'fixture.json'), stop = path.join(directory, 'stop');
for (const file of [fixtureResult, stop]) if (fs.existsSync(file)) fs.unlinkSync(file);
const fixture = spawn(nativeExecutable(), [], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env,
    GSM_APP_ROOT: root, GSM_NODE_EXECUTABLE: process.execPath, GSM_SMOKE_TEST: '1',
    GSM_TEST_SERVICE: path.join(root, 'desktop-runtime/tests/ocr-capture-fixture.mjs'),
    GSM_PROFILE_DIR: path.join(directory, 'fixture-profile'), GSM_TEST_RESULT: path.join(directory, 'fixture-exit.json'),
    GSM_OCR_FIXTURE_IMAGE: image, GSM_FIXTURE_RESULT: fixtureResult, GSM_FIXTURE_STOP: stop,
} });
const exited = new Promise(resolve => fixture.on('exit', resolve));
try {
    for (let n = 0; n < 200 && !fs.existsSync(fixtureResult); n++) await new Promise(resolve => setTimeout(resolve, 100));
    if (!fs.existsSync(fixtureResult)) throw Error('The capture fixture did not open');
    const { hwnd } = JSON.parse(fs.readFileSync(fixtureResult, 'utf8'));
    const results = [];
    for (const engine of ['screenai', 'oneocr', 'bing']) {
        for (const [scenario, areas] of [['full', {}], ['area', { rectangles: [{ coordinates: [480, 340, 530, 300] }] }]]) {
            for (const runtime of ['python', 'rust']) {
                const name = `${engine}-${scenario}-${runtime}`;
                const config = path.join(directory, `${name}-config.json`), result = path.join(directory, `${name}.json`);
                fs.writeFileSync(config, JSON.stringify({ target_id: hwnd, profile: path.join(process.env.APPDATA, 'GameSentenceMiner'), engine, areas, samples: engine === 'bing' ? 5 : 20, settings: { base_scale: 1, monitor_to_capture: 0 }, result }));
                console.log(`Measuring ${name}`);
                if (runtime === 'python') await run(path.join(root, '.venv/Scripts/python.exe'), ['scripts/benchmark_native_ocr.py', config], {}, path.join(directory, `${name}.log`));
                else await run('cargo', [...cargo, 'native_ocr_real_capture_benchmark', '--', '--ignored', '--nocapture'], { GSM_OCR_BENCH_CONFIG: config }, path.join(directory, `${name}.log`));
                const data = JSON.parse(fs.readFileSync(result, 'utf8'));
                if (data.samples.some(sample => !String(sample.text).trim())) throw Error(`${name} did not recognize the game text`);
                const values = key => data.samples.map(sample => sample[key]).sort((a, b) => a - b);
                const median = values => (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
                const summary = { scenario, runtime, engine, median_ms: median(values('total_ms')), p95_ms: values('total_ms')[Math.ceil(data.samples.length * 0.95) - 1], median_capture_ms: median(values('capture_ms')), cpu_seconds: data.cpu_seconds, one_core_percent: data.one_core_percent, total_machine_percent: data.total_machine_percent, samples: data.samples.length, text: data.samples[0].text };
                results.push(summary); console.log(JSON.stringify(summary));
            }
        }
    }
    const comparable = text => text.replaceAll('BLANK_LINE', '').split('\n').filter(line => /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Han}]/u.test(line)).join('').normalize('NFKC').replace(/[\p{P}\p{S}\p{Z}\s]/gu, '');
    for (const result of results.filter(result => result.runtime === 'rust')) {
        const baseline = results.find(row => row.runtime === 'python' && row.engine === result.engine && row.scenario === result.scenario);
        const expected = comparable(baseline.text);
        result.same_japanese_text = ['python','rust'].every(runtime => {
            const run = JSON.parse(fs.readFileSync(path.join(directory,`${result.engine}-${result.scenario}-${runtime}.json`),'utf8'));
            return run.samples.every(sample => comparable(sample.text) === expected);
        });
        if (!result.same_japanese_text) throw Error(`Japanese text differs for ${result.engine}/${result.scenario}; inspect the samples`);
    }
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length, platform: os.release(), source: 'tests/assets/Replay_2025-12-19_22-24-52.mov at 5 seconds', results }, null, 2));
    // Force fresh GPU frames while measuring shared readback, not just cache hits
    // on an unchanged desktop. Restore the original pixels before worker tests.
    const control = path.join(directory, 'fixture-control.json');
    const animate = async enabled => {
        const value = JSON.stringify({animate:enabled,id:Date.now()});fs.writeFileSync(control,value);
        for(let n=0;n<100;n++) {if(fs.existsSync(`${control}.ack`)&&fs.readFileSync(`${control}.ack`,'utf8')===value)return;await new Promise(resolve=>setTimeout(resolve,50));}
        throw Error('Fixture did not apply capture animation');
    };
    await animate(true);
    await run('cargo', [...cargo, 'shared_capture_session_benchmark', '--', '--ignored', '--nocapture'], { GSM_OCR_BENCH_CONFIG: path.join(directory, 'screenai-full-rust-config.json') }, path.join(directory, 'shared-capture.log'));
    await animate(false);
    // Run the actual actor/lifecycle separately from the equal-work engine comparison.
    await run(nativeExecutable(), [], { GSM_APP_ROOT: root, GSM_NODE_EXECUTABLE: process.execPath, GSM_SMOKE_TEST: '1', GSM_TEST_SERVICE: path.join(root, 'desktop-runtime/tests/ocr-runtime-smoke.mjs'), GSM_PROFILE_DIR: path.join(directory, 'worker-profile'), GSM_TEST_RESULT: path.join(directory, 'worker-exit.json'), GSM_OCR_BENCH_DIR: directory, GSM_OCR_BENCH_HWND: String(hwnd) }, path.join(directory, 'worker.log'));
} finally {
    fs.writeFileSync(stop, 'stop');
    const timeout = setTimeout(() => fixture.kill(), 5000);
    await exited; clearTimeout(timeout);
}
