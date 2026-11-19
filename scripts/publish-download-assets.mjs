import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, createWriteStream} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Readable} from 'node:stream';
import {pipeline} from 'node:stream/promises';

const root = path.resolve(import.meta.dirname, '..');
const repository = 'bpwhelan/GameSentenceMiner';
const tag = 'gsm-assets-v1';
const r2Prefix = 'GSMR2:gamesentenceminer/downloads/v1';
const accountId = 'eb6f3aaa8492feed2490ff04c24c21a1';
const publish = process.argv.includes('--publish');
const catalog = JSON.parse(await fs.readFile(path.join(root, 'native/gsm-downloads/assets.json'), 'utf8'));
const sha256 = /^[a-f0-9]{64}$/;
const safeName = /^(?!.*\.$)[a-zA-Z0-9_.+-]+$/;
const digest = value => createHash('sha256').update(value).digest('hex');
const exists = file => fs.access(file).then(() => true, () => false);

async function fileHash(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

function mirrorName(origin, expected) {
  const url = new URL(origin);
  const name = url.pathname.split('/').at(-1);
  if (url.protocol !== 'https:' || url.username || url.password || !safeName.test(name) ||
      (expected ? !sha256.test(expected) : url.search || url.pathname.includes('/latest/'))) {
    throw Error(`Invalid mirror source: ${url.hostname}`);
  }
  return `${expected ?? 'origin-' + digest(url.href)}-${name}`;
}

function gh(args, options = {}) {
  return execFileSync('gh', [...args, '--repo', repository], {
    encoding: 'utf8', windowsHide: true, ...options,
  });
}

async function r2Credentials(token) {
  for (const endpoint of ['user/tokens/verify', `accounts/${accountId}/tokens/verify`]) {
    try {
      const response = await fetch(`https://api.cloudflare.com/client/v4/${endpoint}`, {
        headers: {Authorization: `Bearer ${token}`}, signal: AbortSignal.timeout(25000),
      });
      const result = (await response.json()).result;
      if (result?.status === 'active' && /^[a-f0-9]{32}$/.test(result.id)) {
        return {
          ...process.env,
          RCLONE_CONFIG_GSMR2_TYPE: 's3',
          RCLONE_CONFIG_GSMR2_PROVIDER: 'Cloudflare',
          RCLONE_CONFIG_GSMR2_ACCESS_KEY_ID: result.id,
          RCLONE_CONFIG_GSMR2_SECRET_ACCESS_KEY: digest(token),
          RCLONE_CONFIG_GSMR2_ENDPOINT: `https://${accountId}.r2.cloudflarestorage.com`,
          RCLONE_CONFIG_GSMR2_REGION: 'auto',
        };
      }
    } catch {
      // Suppress diagnostics from credential-bearing requests.
    }
  }
  throw Error('R2_STORAGE did not verify as an active Cloudflare token');
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-download-assets-'));
const mirror = path.join(temporary, 'mirror');
const desktop = path.join(temporary, 'desktop');
await fs.mkdir(mirror);
await fs.mkdir(desktop);
try {
  for (const [id, asset] of Object.entries(catalog)) {
    const name = id.split('/').at(-1);
    if (!safeName.test(name) || !sha256.test(asset.sha256) || !Number.isSafeInteger(asset.bytes) || asset.bytes < 1) {
      throw Error(`Invalid catalog entry: ${id}`);
    }
    const file = path.join(root, asset.source);
    const output = path.join(mirror, `${asset.sha256}-${name}`);
    if (await exists(file)) {
      await fs.copyFile(file, output);
    } else if (asset.origin) {
      const response = await fetch(asset.origin, {signal: AbortSignal.timeout(90000)});
      if (!response.ok || !response.body) throw Error(`Cannot stage ${id} (HTTP ${response.status})`);
      await pipeline(Readable.fromWeb(response.body), createWriteStream(output));
    } else {
      throw Error(`Missing publish source for ${id}`);
    }
    if ((await fs.stat(output)).size !== asset.bytes || await fileHash(output) !== asset.sha256) {
      throw Error(`Catalog verification failed for ${id}`);
    }
  }

  for (let i = 2; i < process.argv.length; i += 1) {
    switch (process.argv[i]) {
      case '--publish':
        break;
      case '--asset': {
        const [origin, file, hashOrDash] = process.argv.slice(i + 1, i + 4);
        if (!origin || !file || !hashOrDash) throw Error('--asset needs URL, file, and SHA-256 or "-"');
        const expected = hashOrDash === '-' ? undefined : hashOrDash;
        const name = mirrorName(origin, expected);
        if (expected && await fileHash(file) !== expected) throw Error(`SHA-256 mismatch for ${name}`);
        await fs.copyFile(file, path.join(mirror, name));
        i += 3;
        break;
      }
      case '--release-dir': {
        const directory = path.resolve(process.argv[++i]);
        for (const entry of await fs.readdir(directory, {withFileTypes: true})) {
          if (!entry.isDirectory()) continue;
          const platform = path.join(directory, entry.name);
          const platformId = entry.name.replace(/^native-release-/, '');
          const manifest = JSON.parse(await fs.readFile(path.join(platform, 'tauri-platform.json'), 'utf8'));
          const runtime = JSON.parse(await fs.readFile(path.join(platform, `agent-runtime-${platformId}.json`), 'utf8'));
          for (const [origin, key, expected] of [
            ...Object.values(manifest.platforms).map(asset => [asset.url, digest(asset.signature), undefined]),
            [runtime.archive.url, runtime.archive.sha256, runtime.archive.sha256],
          ]) {
            const name = mirrorName(origin, key);
            const file = path.join(platform, path.basename(new URL(origin).pathname));
            if (expected && await fileHash(file) !== expected) throw Error(`SHA-256 mismatch for ${name}`);
            await fs.copyFile(file, path.join(desktop, name));
          }
        }
        break;
      }
      default:
        throw Error(`Unknown argument: ${process.argv[i]}`);
    }
  }

  const mirrorFiles = await fs.readdir(mirror);
  const desktopFiles = await fs.readdir(desktop);
  console.log(`Verified ${mirrorFiles.length} shared and ${desktopFiles.length} desktop download assets.`);
  if (publish) {
    const token = process.env.R2_STORAGE?.trim();
    if (token) {
      const env = await r2Credentials(token);
      delete env.R2_STORAGE;
      const rclone = args => execFileSync('rclone', [
        ...args, '--config', process.platform === 'win32' ? 'NUL' : '/dev/null',
        '--s3-no-check-bucket', '--retries', '2', '--timeout', '60s',
      ], {env, stdio: 'inherit', windowsHide: true});
      for (const source of [mirror, desktop]) {
        if (!(await fs.readdir(source)).length) continue;
        rclone(['copy', source, r2Prefix, '--immutable', '--checksum']);
        rclone(['check', source, r2Prefix, '--one-way', '--download']);
      }
    } else {
      console.log('R2_STORAGE is unset. Publication will use GitHub.');
    }

    let existing;
    try {
      existing = JSON.parse(gh(['release', 'view', tag, '--json', 'assets'], {stdio: ['ignore', 'pipe', 'ignore']})).assets;
    } catch {
      gh(['release', 'create', tag, '--draft', '--prerelease', '--latest=false',
        '--title', 'GSM download assets', '--notes', 'Versioned download assets used by GameSentenceMiner.']);
      existing = [];
    }
    const prior = new Set(existing.map(asset => asset.name));
    const verify = path.join(temporary, 'github');
    await fs.mkdir(verify);
    for (const name of mirrorFiles.filter(name => prior.has(name))) {
      gh(['release', 'download', tag, '--pattern', name, '--dir', verify]);
      if (await fileHash(path.join(verify, name)) !== await fileHash(path.join(mirror, name))) {
        throw Error(`GitHub already has different bytes for mirror object ${name}`);
      }
    }
    const missing = mirrorFiles.filter(name => !prior.has(name)).map(name => path.join(mirror, name));
    if (missing.length) gh(['release', 'upload', tag, ...missing]);
    gh(['release', 'edit', tag, '--draft=false', '--prerelease', '--latest=false']);
    console.log('Published GSM download assets.');
  }
} finally {
  if (path.dirname(await fs.realpath(temporary)) === await fs.realpath(os.tmpdir())) {
    await fs.rm(temporary, {recursive: true});
  }
}
