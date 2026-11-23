import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {nativeTargetDirectory, root} from './native-paths.mjs';
import {packagePortable, zipDirectory} from './package-native-portable.mjs';

const target = path.join(await nativeTargetDirectory(), 'release');
const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'))).version;
const output = path.join(root, 'dist/native-preview', `GSM-Preview-${version}-${process.platform}-${process.arch}.zip`);
const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'gsm-preview-'));
const ditto = (...args) => promisify(execFile)('/usr/bin/ditto', args);

try {
  let launch;
  if (process.platform === 'win32') {
    launch = 'Open GSM Preview.exe.';
    await fs.copyFile(path.join(target, 'gsm-desktop.exe'), path.join(staging, 'GSM Preview.exe'));
    await fs.cp(path.join(root, 'build/native-desktop/app'), path.join(staging, 'app'), {recursive: true});
  } else if (process.platform === 'darwin') {
    launch = 'Open GSM Preview.app from the extracted folder. This build uses an ad-hoc signature and requires macOS 14 or later. If macOS blocks the first open, see https://support.apple.com/en-us/102445.';
    await ditto(path.join(target, 'bundle/macos/GSM Preview.app'), path.join(staging, 'GSM Preview.app'));
  } else if (process.platform === 'linux') {
    launch = 'Run GSM-Preview.AppImage. If FUSE is unavailable, run APPIMAGE_EXTRACT_AND_RUN=1 ./GSM-Preview.AppImage in a terminal. If your extractor strips the executable bit, run chmod +x GSM-Preview.AppImage first.';
    const bundle = path.join(target, 'bundle/appimage');
    const images = (await fs.readdir(bundle)).filter(name => /^GSM[ _-]Preview.*\.AppImage$/i.test(name));
    if (images.length !== 1) throw Error(`Expected one preview AppImage, found ${images.length}`);
    const image = path.join(staging, 'GSM-Preview.AppImage');
    await fs.copyFile(path.join(bundle, images[0]), image);
    await fs.chmod(image, 0o755);
  } else {
    throw Error(`Unsupported preview platform: ${process.platform}`);
  }

  await fs.writeFile(path.join(staging, 'README.txt'), [
    `GSM Preview ${version} (${process.platform}-${process.arch})`,
    '',
    'Extract the entire ZIP into its own folder. Quit regular GSM before launching the preview, and quit the preview before returning to regular GSM.',
    launch,
    '',
    'The preview uses your existing GSM settings, database, and downloads, including any custom data location. Changes you make in the preview carry over to regular GSM. The extracted app runs separately from your installed copy, and desktop updates are disabled in the preview.',
    'Some engines and optional resources need internet access on first use. Google Lens uses an online service for each scan.',
    '',
  ].join('\n'));

  if (process.platform === 'darwin') {
    await fs.mkdir(path.dirname(output), {recursive: true});
    await ditto('-c', '-k', '--sequesterRsrc', staging, output);
  } else if (process.platform === 'win32') {
    await packagePortable(staging, output, 'GSM Preview.exe');
  } else {
    await zipDirectory(staging, output);
  }
  console.log('Portable preview:', output);
} finally {
  await fs.rm(staging, {recursive: true, force: true});
}
