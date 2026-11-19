// Run the real bundled engines in disposable Electron profiles. Never opens the user's dictionaries.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import archiver from 'archiver';
import {createWriteStream} from 'node:fs';

const require = createRequire(import.meta.url);
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-dictionary-benchmark-'));
const words = ['食べる', '読む', '歩く', '今日', '日本語', '辞書', '勉強', '漢字'];
const banks = [];
for (let dictionary = 0; dictionary < 6; ++dictionary) {
  const destination = path.join(directory, `${dictionary}.zip`);
  const output = createWriteStream(destination), zip = archiver('zip');
  const written = new Promise((resolve, reject) => { output.on('close', resolve); output.on('error', reject); zip.on('error', reject); });
  zip.pipe(output);
  zip.append(JSON.stringify({title: `GSM benchmark ${dictionary}`, revision: '1', format: 3}), {name: 'index.json'});
  zip.append(JSON.stringify(words.flatMap((word, index) => Array.from({length: 12}, (_, sense) => [
    word, ['たべる', 'よむ', 'あるく', 'きょう', 'にほんご', 'じしょ', 'べんきょう', 'かんじ'][index], '',
    index === 0 ? 'v1' : index < 3 ? 'v5' : '', 100 - sense,
    [`${word} ${dictionary}.${sense}: ${'A realistic length dictionary explanation. '.repeat(12)}`], index * 100 + sense, '',
  ]))), {name: 'term_bank_1.json'});
  await zip.finalize(); await written; banks.push(destination);
}
await fs.writeFile(path.join(directory, 'fixtures.json'), JSON.stringify(banks));
const env = {...process.env}; delete env.ELECTRON_RUN_AS_NODE;
const results = [];
for (const reader of ['yomitan', 'hachidori']) {
  const log = [];
  await new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [path.join(import.meta.dirname, '../GSM_Overlay/tests/dictionary-performance-electron.cjs'), directory, reader],
      {env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
    const timeout = setTimeout(() => { child.kill(); reject(Error(`${reader} benchmark timed out; see ${directory}`)); }, 260000);
    child.stdout.on('data', bytes => log.push(bytes)); child.stderr.on('data', bytes => log.push(bytes));
    child.on('error', error => {clearTimeout(timeout); reject(error);});
    child.on('exit', code => {
      clearTimeout(timeout);
      fs.writeFile(path.join(directory, `${reader}.log`), Buffer.concat(log)).then(() => {
        code === 0 ? resolve() : reject(Error(`${reader} benchmark failed (${code}); see ${directory}`));
      }, reject);
    });
  });
  const result = JSON.parse(await fs.readFile(path.join(directory, `${reader}.json`), 'utf8'));
  results.push(result); console.log(JSON.stringify(result));
}
const report = {fixture: '6 dictionaries, 96 senses each, real engines and extension messaging', results};
if (process.argv[2]) await fs.writeFile(process.argv[2], `${JSON.stringify(report, null, 2)}\n`);
console.log(`Evidence: ${directory}`);
