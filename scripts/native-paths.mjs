import fs from 'node:fs';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..');
export const launchDirectory = path.join(root, 'src-tauri', 'target', 'desktop-runs');
export const launchPointer = path.join(launchDirectory, `${process.platform}-${process.arch}.json`);

export function nativeExecutable() {
  if (process.env.GSM_NATIVE_TEST_EXECUTABLE) return path.resolve(process.env.GSM_NATIVE_TEST_EXECUTABLE);
  const record = JSON.parse(fs.readFileSync(launchPointer, 'utf8'));
  const filename = fs.realpathSync(record.executable);
  const relative = path.relative(fs.realpathSync(launchDirectory), filename);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !fs.statSync(filename).isFile()) {
    throw Error('The native launch record is invalid. Run npm run build:tauri again.');
  }
  return filename;
}
