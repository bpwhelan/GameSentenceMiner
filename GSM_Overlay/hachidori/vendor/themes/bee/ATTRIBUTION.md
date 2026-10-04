# Bee's Theme

Bee's Theme shares the direct JL renderer in `../jl/theme.js` and keeps JL's
typography, repeated dictionary headers, frequencies and pitch marker. Its
blush, magenta and violet palette adapts Hachidori's Girlypop colours, darkened
where text and focus contrast need it. Group tabs share one
frame and equal widths.
See [JL's attribution](../jl/ATTRIBUTION.md) and [Apache-2.0 licence](../jl/LICENSE.Apache-2.0).

The additions are group-only tabs, formatted dictionary content in place of JL's
text and tag brackets, the shared Hachidori personal dictionary editor and custom
link/Anki buttons. Formatted content uses Hachidori's existing structured glossary
renderer, and the audio, Anki and pencil controls share Hachidori's outline icons. The theme never builds
Default's popup. Hachidori integration is GPL-3.0-or-later.

The host supplies `createLookupActions`, `createDictionaryTabs` and
`createImagePreview` components,
plus its existing `appendTextOnlyGlossary` callback, and loads scoped dictionary
styles. Without configured groups with matching results, all definitions appear
without a tab row. Custom actions beyond the first two appear in More actions.
Formatted DOM and image requests are created with each block.
