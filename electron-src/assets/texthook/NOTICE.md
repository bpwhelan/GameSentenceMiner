# Text Hooking Engine Binaries

The binaries shipped under this directory originate from the following
upstream projects and are redistributed under the terms of their original
licenses. See the linked license files for full terms.

## Textractor

- Location: `textractor_builds/_x86`, `textractor_builds/_x64`
- Upstream: https://github.com/Artikash/Textractor
- License: GNU General Public License v3.0

## Luna Hook

- Location: `luna_builds/`
- Upstream: https://github.com/HIllya51/LunaTranslator (Luna Host CLI)
- License: GNU General Public License v3.0

## Sugoi Hook

- The integration approach implemented in
  `electron-src/main/ui/texthook.ts` and the renderer Text Hooking tab
  was inspired by the Sugoi Hook project
  (https://github.com/sugoi-toolkit-official/sugoi-hook), which is also
  released under the GNU General Public License v3.0.

The GameSentenceMiner application as a whole is distributed under the
LGPL-3.0-only license. The binaries and integration concepts above are
included on a per-component basis in compliance with the upstream
licenses.

These files are not checked in, but are built and copied into the distribution during the build process.
