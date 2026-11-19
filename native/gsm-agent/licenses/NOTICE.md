# Native Agent runtime

The native Agent helper statically links the unmodified official Frida Core
17.16.4 devkit, distributed under the wxWindows Library Licence 3.1.
`FRIDA-COPYING` contains its licence and linking exception; `COPYING.LIB`
contains the GNU Library General Public License 2.0 referenced by that licence.

Sources and matching binary devkits:

- https://github.com/frida/frida-core/tree/17.16.4
- https://github.com/frida/frida/releases/tag/17.16.4

Build-time downloads and the optional Wine server downloads are pinned and
verified against SHA-256 digests. Updating Frida requires updating both the
version and corresponding digests in this crate. The helper and these notices
are distributed together as a separately downloaded GSM runtime ZIP. Desktop
installers pin its archive and file SHA-256 hashes in `native/agent-runtime.json`.
