// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2023-2026 Yomitan Authors
// Copyright (C) 2021-2022 Yomichan Authors
// Graph notation follows Yomitan's pronunciation-generator.js (GPL-3.0-or-later),
// including its Jidoujisho-style kana graph: https://github.com/yomidevs/yomitan
import "./render/glossary.js";
import { escapeAnkiHtml as escape } from "./anki-templates.js";

// The level after the word. Yomitan's graph reads it from the pitch; its
// Jidoujisho graph (_pitchValueToPattJJ) repeats a pattern's last level when
// the dictionary gives no particle.
function particleLevel(positions, moraCount, kana) {
  const { isMoraPitchHigh } = globalThis.HDGlossary;
  if (kana && typeof positions === "string") return positions[moraCount] ?? positions.at(-1);
  return isMoraPitchHigh(moraCount, positions) ? "H" : "L";
}

function pitchContour(reading, pitch, kana) {
  const { buildPitchAccentMorae, pitchAccentPositions } = globalThis.HDGlossary;
  // The popup's levels. A pattern is the pitch whenever there is one: the
  // engine keeps it beside a placeholder position of 0.
  const positions = pitchAccentPositions(pitch);
  const morae = buildPitchAccentMorae(reading, positions);
  if (!morae) return null;
  return { morae: morae.map(mora => mora.text),
    levels: [...morae.map(mora => mora.level === "high" ? "H" : "L"), particleLevel(positions, morae.length, kana)] };
}

function graphLine(from, to, radius) {
  // Stop at the dots' edges so hollow downstep/particle marks stay transparent
  // on both light and dark cards, without masks or document-wide SVG IDs.
  const dx = to.x - from.x, dy = to.y - from.y;
  const scale = radius / Math.hypot(dx, dy);
  return `M${from.x + dx * scale} ${from.y + dy * scale}L${to.x - dx * scale} ${to.y - dy * scale}`;
}

function pitchGraph(reading, pitch, kana) {
  const contour = pitchContour(reading, pitch, kana);
  if (!contour) return "";
  const { morae, levels } = contour;
  const step = kana ? 35 : 50, height = kana ? 80 : 100, radius = kana ? 5 : 15;
  const highY = kana ? 10 : 25;
  const lowY = kana ? 35 : 75;
  const points = levels.map((level, index) => ({ x: step * (index + 0.5),
    y: level === "H" ? highY : lowY }));
  const width = step * points.length;
  const label = `${reading}: pitch accent ${pitch.pattern || pitch.position}`;
  const lines = points.slice(1).map((point, index) => {
    const tail = index === morae.length - 1;
    return `<path d="${graphLine(points[index], point, radius)}" fill="none" stroke="currentColor" stroke-width="${kana ? 1.5 : 5}"${tail && !kana ? ' stroke-dasharray="5 5"' : ""}/>`;
  });
  const dots = points.slice(0, -1).map(({ x, y }, index) => {
    const downstep = !kana && levels[index] === "H" && levels[index + 1] === "L";
    return `<circle class="pronunciation-graph-dot" cx="${x}" cy="${y}" r="${radius}" fill="${downstep ? "none" : "currentColor"}"${downstep ? ' stroke="currentColor" stroke-width="5"' : ""}/>`
      + (downstep ? `<circle cx="${x}" cy="${y}" r="5" fill="currentColor"/>` : "");
  });
  const tail = points.at(-1);
  const tailAttributes = `class="pronunciation-graph-tail" data-pitch="${levels.at(-1) === "H" ? "high" : "low"}" fill="none" stroke="currentColor"`;
  // Match Yomitan's distinct particle radius so card CSS for 5-unit mora dots
  // does not fill the hollow JJ particle.
  const particle = kana
    ? `<circle ${tailAttributes} cx="${tail.x}" cy="${tail.y}" r="4" stroke-width="2"/>`
    : `<path ${tailAttributes} d="M${tail.x} ${tail.y + 13}l15 -26h-30Z" stroke-width="5"/>`;
  const labels = kana ? morae.map((mora, index) =>
    `<text x="${points[index].x}" y="70" text-anchor="middle"${Array.from(mora).length > 1 ? ' textLength="30" lengthAdjust="spacingAndGlyphs"' : ""} style="font: 20px sans-serif; fill: currentColor;">${escape(mora)}</text>`).join("") : "";
  return `<svg xmlns="http://www.w3.org/2000/svg" class="pronunciation-graph" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escape(label)}" focusable="false" style="display: inline-block; vertical-align: middle; width: ${width / height * (kana ? 3 : 2)}em; height: ${kana ? 3 : 2}em; max-width: 100%;">`
    + `<title>${escape(label)}</title>${lines.join("")}${dots.join("")}${particle}${labels}</svg>`;
}

export function ankiPitchGraphs(term, kana = false) {
  const reading = term.reading || term.expression;
  return term.pitches.map(group => {
    const graphs = group.pitches.map(pitch => pitchGraph(reading, pitch, kana)).filter(Boolean);
    return graphs.length ? `<b>${escape(group.dictionary)}</b>: ${graphs.join(" ")}` : "";
  }).filter(Boolean).join("<br>");
}
