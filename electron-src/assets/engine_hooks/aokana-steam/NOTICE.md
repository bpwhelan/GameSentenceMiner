# Aokana EXTRA2 engine-hook resources

This package ships no copied resources. TextMeshPro reports Unicode characters and
their positions directly, so there is no character set, compound-character map, or
font table to include, and the package is `manifest.json` plus `payload.js` only.

Everything in it was derived independently for GameSentenceMiner against the live
Steam build recorded in `manifest.json`:

- the choice of `UIAdv.ShowText` as the point where one displayed line begins, and
  of its `updateonly` parameter as the re-application flag;
- the choice of `TextMeshProUGUI.GenerateTextMesh` as the point where the cells for
  that line are final;
- reading `TMP_TextInfo.characterInfo` and `TMP_TextInfo.lineInfo` through Mono's
  own class layout, including the object-header adjustment that turns a value-type
  field offset into an array-element offset;
- the three-point derivation of the canvas-to-window transform through the engine's
  own canvas camera.

`docs/AOKANA_ENGINE_HOOK.md` records how each was established and the live
evidence for it.

The foreground-activation and held-key sequence in `advance()` follows the same
approach as this repository's own `bgi-ethornell` package, which is GameSentenceMiner
code under the repository's licence. No third-party code is included, loaded, or
invoked, and no Agent script or Agent helper is involved.

The Mono embedding API (`mono_class_from_name`, `mono_field_get_offset`,
`mono_runtime_invoke`, and the rest) is called through the runtime the game already
ships, `MonoBleedingEdge/EmbedRuntime/mono-2.0-bdwgc.dll`. Mono is distributed by its
authors under the MIT licence; nothing from it is redistributed here.
