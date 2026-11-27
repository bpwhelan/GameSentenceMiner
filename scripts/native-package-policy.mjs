import fs from 'node:fs/promises';
import {readFileSync} from 'node:fs';
import path from 'node:path';

const downloadCatalog = JSON.parse(readFileSync(new URL('../native/gsm-downloads/assets.json', import.meta.url)));
const downloadableFiles = new Set(Object.values(downloadCatalog).map(asset => asset.source));
for (const id of Object.keys(downloadCatalog)) {
  if (id.startsWith('icons/')) downloadableFiles.add('assets/' + id.slice('icons/'.length));
}

const generatedDirectories = new Set([
  'node_modules',
  '.git',
  '__pycache__',
  'test',
  'tests',
  'out',
  'target',
  'target-validation',
  '.venv',
  'test-results',
]);
const forbiddenRuntimeDirectories = [
  'runtime',
  'node_modules',
  'desktop-runtime',
  'dist/main',
  'dist/shared',
];
const slash = value => String(value).replaceAll('\\', '/').replace(/^\.\//, '');

export const forbiddenDependencies = [
  'conf',
  'frida',
  'obs-websocket-js',
  'electron',
  'electron-builder',
  'electron-updater',
  'electron-log',
  'electron-store',
  '@electron',
  'node-window-manager',
  'extract-file-icon',
  'react',
  'react-dom',
  'react-markdown',
  'rehype-sanitize',
  'remark-gfm',
  '@xterm',
];

export function includeSource(relative, platform = process.platform) {
  const name = slash(relative);
  if (!name) return true;
  if (downloadableFiles.has(name)) return false;
  for (const prefix of forbiddenRuntimeDirectories) {
    if (name === prefix || name.startsWith(prefix + '/')) return false;
  }
  if (name.split('/').some(part => generatedDirectories.has(part))) return false;
  if (/\.(?:py|pyi|pyw|pyd|pyc|pyo|map|pdb|obj|ilk|exp|d\.ts|tsbuildinfo)$|\.(?:test|spec)\.[^/]+$/.test(name)) return false;
  if (name === 'native/gsm-agent' || name.startsWith('native/gsm-agent/') || /(?:^|\/)gsm-agent-(?:host(?:\.exe)?|runtime-[^/]+\.zip)$/.test(name)) return false;
  if (/^native\/gsm-(settings|packages|intake)(\/|$)/.test(name)) return false;
  if (name.startsWith('native/gsm-runtime/') || name === 'native/gsm-runtime') return false;
  if (name === 'GameSentenceMiner' || name.startsWith('GameSentenceMiner/')) return false;
  if (name === 'electron-src/assets/python' || name.startsWith('electron-src/assets/python/')) return false;
  if (['pyproject.toml', 'uv.lock', '.python-version'].includes(name) || name.endsWith('.whl')) return false;
  if (/^(?:electron-src\/)?assets\/qt(?:\/|$)/.test(name)) return false;
  if (name === 'assets/scripts/legacy_dictionary_export.py' || name.startsWith('assets/scripts/vendor/chromium-reader') || name.startsWith('assets/scripts/vendor/simple-snappy')) return false;
  if (name === 'GSM_Overlay/window.js') return false;
  if (name.endsWith('/mecab_bridge.py') || /(?:^|\/)system_(?:small|core|full)\.dic$/.test(name)) return false;
  return true;
}

export function includeDependency() {
  return false;
}

export async function pruneDependencies(directory) {
  for (const dir of forbiddenRuntimeDirectories) {
    await fs.rm(path.join(directory, dir), { recursive: true, force: true });
  }
}

export async function auditNativePackage(directory, options = process.platform) {
  const platform = typeof options === 'string' ? options : (options?.platform ?? process.platform);
  const root = path.resolve(directory), files = [], groups = {};
  async function visit(folder) {
    for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
      const filename = path.join(folder, entry.name);
      const relative = slash(path.relative(root, filename));
      if (forbiddenRuntimeDirectories.some(dir => relative === dir || relative.startsWith(dir + '/'))) {
        throw Error(`Forbidden Node/JS runtime payload in staged package: ${relative}`);
      }
      if (entry.isDirectory() && (await fs.readdir(filename)).length === 0) continue;
      if (
        !includeSource(relative, platform) ||
        (relative.startsWith('assets/') && !includeSource('electron-src/' + relative, platform)) ||
        relative === 'dist/renderer/legacy/changelog' ||
        relative === 'dist/renderer/legacy/texthook'
      ) {
        throw Error(`Forbidden artifact in staged package: ${relative}`);
      }
      if (entry.isDirectory()) await visit(filename);
      else if (entry.isFile()) {
        if (entry.name === 'node.exe' || entry.name === 'node') {
          throw Error(`Forbidden Node binary in staged package: ${relative}`);
        }
        const bytes = (await fs.stat(filename)).size;
        files.push({ path: relative, bytes });
        const group = relative.split('/')[0];
        groups[group] = (groups[group] || 0) + bytes;
      }
    }
  }
  await visit(root);
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  const renderer = files.filter(file => file.path.startsWith('dist/renderer/')).reduce((sum, file) => sum + file.bytes, 0);
  if (renderer > 6 * 1024 ** 2) throw Error(`Renderer resources exceed the 6 MiB budget: ${renderer} bytes`);
  if (platform === 'win32' && total > 300 * 1024 ** 2) throw Error(`Windows resources exceed the 300 MiB budget: ${total} bytes`);
  return {
    total,
    count: files.length,
    totalBytes: total,
    totalMiB: +(total / 1024 ** 2).toFixed(2),
    fileCount: files.length,
    renderer,
    groups,
    largest: files.sort((a, b) => b.bytes - a.bytes).slice(0, 20),
  };
}

function inside(root, relative) {
  const filename = path.resolve(root, relative);
  if (!filename.startsWith(path.resolve(root) + path.sep)) throw Error(`Asset escapes its root: ${relative}`);
  return filename;
}

export async function stageChangelog(source, destination, version) {
  const manifest = JSON.parse(await fs.readFile(path.join(source, 'manifest.json'), 'utf8'));
  const current = manifest.releases.find(entry => entry.version === version)
    ?? manifest.releases.find(entry => entry.version === version.split(/[+-]/)[0]);
  const releases = current ? [current] : [];
  await fs.mkdir(destination, { recursive: true });
  await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify({ ...manifest, releases }, null, 2));
  for (const entry of releases) {
    const relative = entry.file || `releases/${entry.version}.md`;
    const markdown = await fs.readFile(inside(source, relative), 'utf8');
    const localImages = new Set();
    for (const [, , ref] of markdown.matchAll(/!\[([^\]]*)]\(([^)\s]+)(\s+["'][^"']*["'])?\)/g)) {
      if (/^(?:https?:|data:|blob:|gsm-changelog:)/i.test(ref)) continue;
      inside(path.join(source, 'images'), ref);
      localImages.add(ref);
    }
    const output = inside(destination, relative);
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, markdown);
    for (const ref of localImages) {
      const output = inside(path.join(destination, 'images'), ref);
      await fs.mkdir(path.dirname(output), { recursive: true });
      await fs.copyFile(inside(path.join(source, 'images'), ref), output);
    }
  }
}
