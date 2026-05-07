const { FusesPlugin } = require('@electron-forge/plugin-fuses');
const { FuseV1Options, FuseVersion } = require('@electron/fuses');
const fs = require('fs');
const path = require('path');

const isWindows = process.platform === 'win32';
const isMac = process.platform === 'darwin';

const ignoredPackagerEntries = new Set([
  '.github',
  '__pycache__',
  'bin',
  'input_server',
  'jiten.reader',
  'out',
  'scripts',
  'yomitan',
]);

const ignoredPackagerFiles = new Set([
  '.gitignore',
  'Node.gitignore',
  'README.md',
  'overlay.xcf',
  'package-lock.json',
  'yomitan_update_instructions.md',
  'yomitan_update_prompt.md',
]);

function normalizePackagerPath(filePath) {
  if (!filePath) {
    return '';
  }

  const normalizedPath = filePath.replace(/\\/g, '/');
  if (/^\/(?!\/)/.test(normalizedPath)) {
    return normalizedPath.replace(/^\/+/, '');
  }

  if (!path.isAbsolute(filePath)) {
    return normalizedPath.replace(/^\/+/, '');
  }

  return path.relative(__dirname, filePath).replace(/\\/g, '/');
}

function ignorePackagerFile(filePath) {
  const relativePath = normalizePackagerPath(filePath);
  if (!relativePath || relativePath.startsWith('..')) {
    return false;
  }

  const topLevelEntry = relativePath.split('/')[0];
  return ignoredPackagerEntries.has(topLevelEntry) || ignoredPackagerFiles.has(relativePath);
}

function resolveInputServerExtraResource() {
  const executableName = isWindows ? 'gsm_overlay_server.exe' : 'gsm_overlay_server';
  const candidates = [
    path.join('input_server', 'bin', process.platform, executableName),
    path.join('input_server', 'bin', executableName),
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(__dirname, candidate))) {
      return candidate;
    }
  }

  return candidates[0];
}

module.exports = {
  packagerConfig: {
    asar: true,
    icon: isWindows ? './overlay.ico' : (isMac ? undefined : './overlay-256.png'),
    ignore: ignorePackagerFile,
    "extraResource": ["yomitan", "jiten.reader", resolveInputServerExtraResource(), "input_server/mecab_bridge.py"],
  },
  rebuildConfig: {},
  makers: [
    {
      name: '@electron-forge/maker-squirrel',
      config: {
        setupIcon: './overlay.ico',
      },
    },
    {
      name: '@electron-forge/maker-zip',
      platforms: ['darwin'],
    },
    {
      name: '@electron-forge/maker-deb',
      config: {
        icon: './overlay-256.png',
      },
    },
    {
      name: '@electron-forge/maker-rpm',
      config: {
        icon: './overlay-256.png',
      },
    },
  ],
  plugins: [
    {
      name: '@electron-forge/plugin-auto-unpack-natives',
      config: {},
    },
    // Fuses are used to enable/disable various Electron functionality
    // at package time, before code signing the application
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
    }),
  ],
};
