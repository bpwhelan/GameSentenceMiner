// SPDX-License-Identifier: GPL-3.0-or-later

// Runs in the page's main world on docs.google.com at document_start, before
// Docs' own bundle, so no extension API is available here. Docs paints text to
// <canvas>; when this property names an allow-listed extension ID it also draws
// an SVG annotation layer whose <rect aria-label> elements carry each run of
// text. The value is the ID Google's allow-list checks, which Yomitan also uses.
window._docs_annotate_canvas_by_ext = "ogmnaimimemjmbakcfefmnahgdfhfami";
