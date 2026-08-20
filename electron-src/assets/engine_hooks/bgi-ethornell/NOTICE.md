# BGI / Ethornell engine-hook resources

The `textCapture` signature is the BGI4 pattern from
[Textractor](https://github.com/Artikash/Textractor)'s BGI engine support, reached
here through the local `UniversalOtakuHooker` port at `scripts/engines/bgi.js`.
Textractor is distributed under the GNU General Public License v3.0. Only the byte
pattern and the convention that the displayed string arrives in `eax` are taken from
it; no Textractor code is included, loaded, or invoked.

Everything else in this package was derived independently for GameSentenceMiner
against live builds: the glyph-draw, copy-dispatcher and surface-lock signatures, the
copy-chain traversal that turns glyph positions into client pixels, the ruby handling,
and the pairing of captured strings with drawn glyphs. `docs/BGI_ENGINE_HOOK.md`
records how each was established.

This package needs no character-set or compound-character resources: BGI hands over
Unicode text directly.
