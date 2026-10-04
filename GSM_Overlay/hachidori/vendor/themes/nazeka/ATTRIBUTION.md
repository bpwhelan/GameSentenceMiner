# Nazeka

Based on [wareya/nazeka](https://github.com/wareya/nazeka), pinned at
`8b220fbfc6c20fe1959af8eed7e8d02e023d4b41`.

Copyright 2017 wareya. Licensed under Apache-2.0; see LICENSE.Apache-2.0.
The upstream README records copyright 2017–2019.

Adapted from `texthook.js`: `get_style()` and default settings (colours,
fonts, inline readings and original-text float), and `build_div_inner()`
(original-text context shortening). Modified for Hachidori's structured lookup
model, core actions, independent stylesheet and version 2 renderer contract.
The integration and remaining new code are GPL-3.0-or-later.

This is an adapted popup, not the full Nazeka extension. Hachidori supplies
lookup, deinflection, audio, mining, navigation and positioning. No Nazeka
background engine or bundled dictionary data is included.

The placement of the borderless audio control immediately after the reading,
and the Anki control after entry metadata, also follows JL's layout:
[`PopupContentGenerator.cs`](https://github.com/rampaa/JL/blob/b490928aa3a23eb5d4fa9359961f5b686bc0eaae/JL.Windows/GUI/Popup/PopupContentGenerator.cs).
JL is used as a visual reference; no C# source is copied into this renderer.
