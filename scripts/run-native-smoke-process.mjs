import {spawn} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

async function coldBrowserFailure(scenario, phase, error, profile) {
  if (process.platform !== 'win32' || typeof error !== 'string') return false;
  if (scenario === 'yomitan' && phase === 'import') return error === 'warmup lookup: Extension script timed out';
  if (scenario === 'overlay') return error === 'Overlay dictionary did not become ready';
  if (scenario !== 'settings') return false;
  const noEngine = 'Dictionary engine did not become ready (no response)';
  if (error.includes(noEngine)) return true;
  if (!error.includes("Cannot read properties of undefined (reading 'sendMessage')")) return false;
  const log = await fs.readFile(path.join(profile, 'logs', 'desktop.log'), 'utf8').catch(() => '');
  return log.includes(noEngine);
}

export async function runNativeSmokeProcess(executable, cwd, env, scenario, phase) {
  const resultFile = env.GSM_TEST_RESULT;
  const profile = env.GSM_PROFILE_DIR;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const code = await new Promise((resolve, reject) => {
      const child = spawn(executable, [], {cwd, env, windowsHide: true, stdio: 'inherit'});
      const timer = setTimeout(() => {
        child.kill();
        reject(Error(`Native smoke timed out (${scenario}/${phase}); evidence: ${profile}`));
      }, 180000);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    const result = await fs.readFile(resultFile, 'utf8').then(JSON.parse).catch(() => null);
    if (code === 0 && result?.code === 0) return result;
    if (attempt === 2 || !await coldBrowserFailure(scenario, phase, result?.error, profile)) {
      throw Error(`Native smoke failed (${scenario}/${phase}: ${result?.error ?? 'exit ' + code}); evidence: ${profile}`);
    }
    // The first browser process stopped during initialization, before the fixture
    // dictionary or behavioral checks. Preserve its evidence and run those checks
    // in a new WebView2 process against exactly the same application and profile.
    await fs.rename(resultFile, resultFile + '.first-attempt');
    const message = `Restarting ${scenario}/${phase} after cold WebView2 startup failed: ${result.error}`;
    console.warn(message);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, message.split('\n')[0] + '\n\n');
    }
  }
}
