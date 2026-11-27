// Benchmark native OCR engines against the same Japanese capture fixture.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { nativeExecutable, root } from './native-paths.mjs';
if (process.platform !== 'win32') throw Error('This benchmark measures Windows Graphics Capture.');
const directory = path.resolve(process.argv[2] || '.tmp-ocr-benchmark');
fs.mkdirSync(directory, { recursive: true });
const run = (file, args, env = {}, log) => new Promise((resolve, reject) => {
    const child = spawn(file, args, { cwd: root, windowsHide: true, env: { ...process.env, ...env }, stdio: log ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    const output = log ? fs.createWriteStream(log) : null;
    if (output) { child.stdout.pipe(output); child.stderr.pipe(output); }
    child.on('error', reject);
    child.on('exit', code => { output?.end(); code === 0 ? resolve() : reject(Error(`${file} exited ${code}; see ${log || 'output'}`)); });
});
const cargo = ['test', '--locked', '--manifest-path', 'src-tauri/Cargo.toml'];
await run('cargo', [...cargo, '--no-run']);
const fixtureResult = path.join(directory, 'fixture.json'), stop = path.join(directory, 'stop');
const control = path.join(directory, 'fixture-control.json');
for (const file of [fixtureResult, stop, control]) if (fs.existsSync(file)) fs.unlinkSync(file);
const fixture = spawn(nativeExecutable(), [], { cwd: root, windowsHide: true, stdio: 'ignore', env: { ...process.env,
    GSM_APP_ROOT: root, GSM_SMOKE_SUITE: 'capture-fixture', GSM_SMOKE_TEST: '1',
    GSM_PROFILE_DIR: path.join(directory, 'fixture-profile'), GSM_TEST_RESULT: path.join(directory, 'fixture-exit.json'),
    GSM_FIXTURE_CONTROL: control, GSM_FIXTURE_RESULT: fixtureResult, GSM_FIXTURE_STOP: stop,
} });
const exited = new Promise(resolve => fixture.on('close', resolve));
fixture.on('error', error => console.error(error.message));
try {
    for (let n = 0; n < 200 && !fs.existsSync(fixtureResult); n++) await new Promise(resolve => setTimeout(resolve, 100));
    if (!fs.existsSync(fixtureResult)) throw Error('The capture fixture did not open');
    const { hwnd } = JSON.parse(fs.readFileSync(fixtureResult, 'utf8'));
    const results = [];
    for (const engine of ['screenai', 'oneocr', 'bing']) {
        for (const [scenario, areas] of [['full', {}], ['area', { rectangles: [{ coordinates: [45, 65, 930, 330] }] }]]) {
            const name = `${engine}-${scenario}-rust`;
            const config = path.join(directory, `${name}-config.json`), result = path.join(directory, `${name}.json`);
            fs.writeFileSync(config, JSON.stringify({ target_id: hwnd, profile: path.join(process.env.APPDATA, 'GameSentenceMiner'), engine, areas, samples: engine === 'bing' ? 5 : 20, settings: { base_scale: 1, monitor_to_capture: 0 }, result }));
            console.log(`Measuring ${name}`);

            await run('cargo', [...cargo, 'native_ocr_real_capture_benchmark', '--', '--ignored', '--nocapture'], { GSM_OCR_BENCH_CONFIG: config }, path.join(directory, `${name}.log`));
            const data = JSON.parse(fs.readFileSync(result, 'utf8'));
            if (data.samples.some(sample => !String(sample.text).trim())) throw Error(`${name} did not recognize the fixture text`);
            const values = key => data.samples.map(sample => sample[key]).sort((a, b) => a - b);
            const median = values => (values[Math.floor((values.length - 1) / 2)] + values[Math.floor(values.length / 2)]) / 2;
            const summary = { scenario, engine, median_ms: median(values('total_ms')), p95_ms: values('total_ms')[Math.ceil(data.samples.length * 0.95) - 1], median_capture_ms: median(values('capture_ms')), cpu_seconds: data.cpu_seconds, one_core_percent: data.one_core_percent, total_machine_percent: data.total_machine_percent, samples: data.samples.length, text: data.samples[0].text };
            results.push(summary); console.log(JSON.stringify(summary));
        }
    }
    fs.writeFileSync(path.join(directory, 'summary.json'), JSON.stringify({ cpu: os.cpus()[0]?.model, logical_cpus: os.cpus().length, platform: os.release(), source: 'Japanese text in the native capture fixture', results }, null, 2));
    // Feed WGC new frames during the shared-readback measurement.
    fs.writeFileSync(control, JSON.stringify({ width: 1920, height: 1080 }));
    await new Promise(resolve => setTimeout(resolve, 500));
    let light = true;
    const animation = setInterval(() => {
        light = !light;
        fs.writeFileSync(control, JSON.stringify({ color: light ? 'white' : 'gainsboro' }));
    }, 100);
    try {
        await run('cargo', [...cargo, 'shared_capture_session_benchmark', '--', '--ignored', '--nocapture'], { GSM_OCR_BENCH_CONFIG: path.join(directory, 'screenai-full-rust-config.json') }, path.join(directory, 'shared-capture.log'));
    } finally {
        clearInterval(animation);
    }
} finally {
    fs.writeFileSync(stop, 'stop');
    const timeout = setTimeout(() => fixture.kill(), 5000);
    await exited; clearTimeout(timeout);
}
