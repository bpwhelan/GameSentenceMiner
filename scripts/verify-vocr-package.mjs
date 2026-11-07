import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const graphNames = ['small', 'normal', 'large', 'textspot8'].map(name => `${name}-faithful.onnx`).sort();
const notices = ['COPYING', 'VOCR6-ATTRIBUTION.md', 'SPOTTER-ATTRIBUTION.md', 'NOTICE.md'];
const revision = '205f47ec4e56ca87c00e7dba0a61c9aaec726707';

export async function verifyVocrBundle(directory) {
  const manifest = JSON.parse(await fs.readFile(path.join(directory, 'manifest.json'), 'utf8'));
  if (manifest.revision !== revision || manifest.export_version !== 1 || manifest.release !== 'v0.5.0') {
    throw new Error('VOCR package manifest is incompatible');
  }
  const declared = Object.keys(manifest.files || {}).sort();
  const present = (await fs.readdir(directory)).filter(name => name.endsWith('.onnx')).sort();
  if (JSON.stringify(declared) !== JSON.stringify(graphNames) || JSON.stringify(present) !== JSON.stringify(graphNames)) {
    throw new Error('VOCR package must contain exactly the four faithful ONNX graphs');
  }
  let bytes = 0;
  for (const name of graphNames) {
    const data = await fs.readFile(path.join(directory, name));
    if (createHash('sha256').update(data).digest('hex') !== manifest.files[name]) {
      throw new Error(`VOCR package checksum failed: ${name}`);
    }
    bytes += data.length;
  }
  for (const name of notices) {
    if (!(await fs.readFile(path.join(directory, name), 'utf8')).trim()) {
      throw new Error(`VOCR package attribution is empty: ${name}`);
    }
  }
  return { graphs: graphNames.length, bytes };
}

// Runs after extraFiles has been copied and before signing/installer creation.
// Follow extraFiles' destination relative to Contents on macOS, appOutDir elsewhere.
export default async function afterPack(context) {
  const root = context.electronPlatformName === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents')
    : context.appOutDir;
  const directory = path.join(root, 'resources', 'GameSentenceMiner', 'assets', 'vocr');
  const result = await verifyVocrBundle(directory);
  console.log(`Verified packaged VOCR: ${result.graphs} faithful graphs (${result.bytes} bytes)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2] || path.resolve('GameSentenceMiner/assets/vocr');
  const result = await verifyVocrBundle(directory);
  console.log(`Verified VOCR: ${result.graphs} faithful graphs (${result.bytes} bytes) in ${directory}`);
}
