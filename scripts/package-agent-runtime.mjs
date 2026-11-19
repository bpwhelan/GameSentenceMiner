// Publish Frida separately from the desktop; installers carry only this manifest.
import fs from 'node:fs/promises';
import {createWriteStream} from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(import.meta.dirname, '..');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const runtimeLicenses = ['NOTICE.md', 'FRIDA-COPYING', 'COPYING.LIB'];

export async function packageAgentRuntime({executable, output, version, platform = `${process.platform}-${process.arch}`, licenses = path.join(root, 'native/gsm-agent/licenses')}) {
  // Release validation runs without npm dependencies on the publishing runner.
  const {default: archiver} = await import('archiver');
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw Error('Invalid Agent runtime release version');
  if (!/^(win32-(x64|arm64)|linux-x64|darwin-(x64|arm64))$/.test(platform)) throw Error(`Unsupported Agent runtime platform: ${platform}`);
  const executableName = platform.startsWith('win32-') ? 'gsm-agent-host.exe' : 'gsm-agent-host';
  const files = [{path: executableName, source: executable}, ...runtimeLicenses.map(name => ({path: `licenses/${name}`, source: path.join(licenses, name)}))];
  // Fixed timestamps, modes and order make identical payloads reusable between releases.
  const contents = await Promise.all(files.map(async file => ({...file, bytes: await fs.readFile(file.source)})));
  await fs.mkdir(output, {recursive: true});
  const temporary = path.join(output, `.agent-runtime-${crypto.randomUUID()}.zip`);
  try {
    await new Promise((resolve, reject) => {
      const stream = createWriteStream(temporary), zip = archiver('zip', {zlib: {level: 9}});
      stream.on('close', resolve); stream.on('error', reject); zip.on('error', reject); zip.on('warning', reject);
      zip.pipe(stream);
      for (const file of contents) zip.append(file.bytes, {name: file.path, date: new Date('2000-01-01T00:00:00Z'), mode: file.path === executableName ? 0o755 : 0o644});
      void zip.finalize();
    });
    const sha256 = hash(await fs.readFile(temporary));
    const name = `gsm-agent-runtime-${platform}-${sha256}.zip`;
    const archive = path.join(output, name);
    await fs.copyFile(temporary, archive);
    const manifest = {
      schemaVersion: 1, fridaVersion: '17.16.4', hostProtocol: 2, platform,
      archive: {url: `https://github.com/bpwhelan/GameSentenceMiner/releases/download/v${version}/${name}`, sha256},
      files: contents.map(file => ({path: file.path, sha256: hash(file.bytes)})),
    };
    await fs.writeFile(path.join(output, 'agent-runtime.json'), JSON.stringify(manifest, null, 2) + '\n');
    return {manifest, archive};
  } finally {
    await fs.rm(temporary, {force: true});
  }
}

export async function verifyAgentRuntimeArchive(manifest, archive) {
  if (hash(await fs.readFile(archive)) !== manifest.archive.sha256 || path.basename(archive) !== new URL(manifest.archive.url).pathname.split('/').at(-1)) {
    throw Error('Agent runtime release archive does not match the installer metadata');
  }
}
