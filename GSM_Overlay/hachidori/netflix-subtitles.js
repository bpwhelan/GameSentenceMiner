// SPDX-License-Identifier: GPL-3.0-or-later

// Experimental Netflix mining: Netflix's subtitle files as cue timelines, and
// the cue a hovered subtitle line belongs to. netflix.js registers this classic
// script on netflix.com while the flag is on; Node tests load it directly. It
// has no Chrome dependency and produces plain text, never HTML.
(function () {
  "use strict";

  // A hovered line belongs to a cue that is active this close to the video's time.
  const MATCH_TOLERANCE_MS = 500;
  const TTML_PARAMETER = "http://www.w3.org/ns/ttml#parameter";
  const TTML_STYLING = "http://www.w3.org/ns/ttml#styling";
  const XML_NAMESPACE = "http://www.w3.org/XML/1998/namespace";
  // Direction marks Netflix puts at the start of lines (Subadub issue #1) and a BOM.
  const INVISIBLE = /[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/gu;
  const NAMED_ENTITIES = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0", lrm: "\u200e", rlm: "\u200f" };
  // TTML ruby parts that are readings or their fallback parentheses, not the line.
  const RUBY_READINGS = new Set(["text", "textContainer", "delimiter"]);

  function decodeEntities(text) {
    return text.replace(/&(?:#(\d+)|#x([0-9a-f]+)|([a-z]+));/giu, (match, decimal, hex, name) => {
      if (decimal !== undefined || hex !== undefined) {
        const code = Number.parseInt(decimal ?? hex, decimal === undefined ? 16 : 10);
        return code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      const key = name.toLowerCase();
      return Object.hasOwn(NAMED_ENTITIES, key) ? NAMED_ENTITIES[key] : match;
    });
  }

  // Lines without their direction marks or surrounding spaces; empty lines go.
  function cleanLines(text) {
    return text.split("\n").map(line => line.replace(INVISIBLE, "").trim()).filter(Boolean).join("\n");
  }

  function sortCues(cues) {
    return cues.sort((left, right) => left.startMs - right.startMs || left.endMs - right.endMs);
  }

  const VTT_TIME = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/u;

  function vttTime(value) {
    const match = VTT_TIME.exec(value);
    if (!match) return null;
    const [, hours = "0", minutes, seconds, fraction] = match;
    return ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000 + Number(fraction.padEnd(3, "0"));
  }

  // How deep inside ruby readings the text after `tag` (its name, lowercased)
  // is. WebVTT lets the last </rt> before </ruby> be left out; </ruby> ends it.
  function readingDepth(tag, depth) {
    if (/^\/ruby(?![a-z])/u.test(tag)) return 0;
    if (/^\/?r[tp](?![a-z])/u.test(tag)) return Math.max(0, depth + (tag.startsWith("/") ? -1 : 1));
    return depth;
  }

  // A cue's text without its tags. Ruby readings and their parentheses are
  // not part of the spoken line, so text inside <rt> and <rp> is left out.
  // WebVTT escapes a literal "<", so every "<" opens a tag.
  function vttText(lines) {
    const source = lines.join("\n");
    let text = "";
    let hidden = 0;
    let at = 0;
    while (at < source.length) {
      const open = source.indexOf("<", at);
      const close = open < 0 ? -1 : source.indexOf(">", open);
      if (close < 0) {
        if (hidden === 0) text += source.slice(at);
        break;
      }
      if (hidden === 0) text += source.slice(at, open);
      hidden = readingDepth(source.slice(open + 1, close).toLowerCase(), hidden);
      at = close + 1;
    }
    return cleanLines(decodeEntities(text));
  }

  function parseWebVtt(source) {
    const text = String(source).replace(/^\ufeff/u, "").replace(/\r\n?/gu, "\n");
    if (!/^WEBVTT(?:[ \t]|\n|$)/u.test(text)) throw new Error("This is not a WebVTT subtitle file.");
    const cues = [];
    for (const block of text.split(/\n[ \t]*\n/u)) {
      const lines = block.split("\n");
      const at = lines.findIndex(line => line.includes("-->"));
      if (at < 0) continue;
      const [start, rest] = lines[at].split("-->");
      const startMs = vttTime(start.trim());
      const endMs = vttTime(rest.trim().split(/[ \t]+/u)[0]);
      if (startMs === null || endMs === null || endMs < startMs) continue;
      const cueText = vttText(lines.slice(at + 1));
      if (cueText) cues.push({ startMs, endMs, text: cueText });
    }
    return sortCues(cues);
  }

  function attribute(element, namespace, localName) {
    for (const item of element.attributes) {
      if (item.localName === localName && item.namespaceURI === namespace) return item.value;
    }
    return null;
  }

  const CLOCK_TIME = /^(\d+):(\d{2}):(\d{2})(?:\.(\d+)|:(\d+(?:\.\d+)?))?$/u;
  const OFFSET_TIME = /^(\d+(?:\.\d+)?)(h|ms|m|s|f|t)$/u;
  const OFFSET_UNITS = { h: 3_600_000, m: 60_000, s: 1000, ms: 1 };

  // TTML clock times (frames included) and offset times, ticks among them.
  function ttmlTime(value, rates) {
    if (value === null) return null;
    const text = value.trim();
    const clock = CLOCK_TIME.exec(text);
    if (clock) {
      const [, hours, minutes, seconds, fraction, frames] = clock;
      let ms = ((Number(hours) * 60 + Number(minutes)) * 60 + Number(seconds)) * 1000;
      if (fraction !== undefined) ms += Number(`0.${fraction}`) * 1000;
      if (frames !== undefined) ms += Number(frames) / rates.frameRate * 1000;
      return Math.round(ms);
    }
    const offset = OFFSET_TIME.exec(text);
    if (!offset) return null;
    const amount = Number(offset[1]);
    if (offset[2] === "t") return Math.round(amount / rates.tickRate * 1000);
    if (offset[2] === "f") return Math.round(amount / rates.frameRate * 1000);
    return Math.round(amount * OFFSET_UNITS[offset[2]]);
  }

  function timingRates(root) {
    const frameRate = Number(attribute(root, TTML_PARAMETER, "frameRate")) || 30;
    const subFrameRate = Number(attribute(root, TTML_PARAMETER, "subFrameRate")) || 1;
    // Without a tick rate, TTML counts ticks in sub-frames when it states a
    // frame rate and in seconds otherwise.
    const declared = attribute(root, TTML_PARAMETER, "frameRate") === null ? 1 : frameRate * subFrameRate;
    return { frameRate, tickRate: Number(attribute(root, TTML_PARAMETER, "tickRate")) || declared };
  }

  function rubyRole(element, styles) {
    const inline = attribute(element, TTML_STYLING, "ruby");
    if (inline !== null) return inline;
    for (const id of (element.getAttribute("style") ?? "").trim().split(/\s+/u)) {
      if (styles.has(id)) return styles.get(id);
    }
    return null;
  }

  function paragraphText(node, styles) {
    let text = "";
    for (const child of node.childNodes) {
      // XML line breaks in a text node are spaces; <br> is the line break.
      if (child.nodeType === 3 || child.nodeType === 4) text += child.nodeValue.replace(/[\r\n\t]+/gu, " ");
      else if (child.nodeType === 1 && child.localName === "br") text += "\n";
      else if (child.nodeType === 1 && !RUBY_READINGS.has(rubyRole(child, styles))) text += paragraphText(child, styles);
    }
    return text;
  }

  // Time containment: a paragraph's begin counts from its containers' begin.
  function containerOffset(element, rates) {
    let offset = 0;
    for (let node = element.parentElement; node; node = node.parentElement) {
      offset += ttmlTime(node.getAttribute("begin"), rates) ?? 0;
    }
    return offset;
  }

  // TTML, DFXP and IMSC through the platform's XML parser; tests pass jsdom's.
  function parseTtml(source, { DOMParser: Parser = globalThis.DOMParser } = {}) {
    if (typeof Parser !== "function") throw new Error("TTML subtitles need an XML parser.");
    const document = new Parser().parseFromString(String(source), "application/xml");
    const root = document.documentElement;
    if (root?.localName !== "tt" || document.getElementsByTagName("parsererror").length > 0) {
      throw new Error("This is not a TTML subtitle file.");
    }
    const rates = timingRates(root);
    const styles = new Map();
    for (const style of document.getElementsByTagNameNS("*", "style")) {
      const id = attribute(style, XML_NAMESPACE, "id");
      const role = attribute(style, TTML_STYLING, "ruby");
      if (id !== null && role !== null) styles.set(id, role);
    }
    const cues = [];
    for (const paragraph of document.getElementsByTagNameNS("*", "p")) {
      const begin = ttmlTime(paragraph.getAttribute("begin"), rates);
      const end = ttmlTime(paragraph.getAttribute("end"), rates);
      const duration = ttmlTime(paragraph.getAttribute("dur"), rates);
      if (begin === null || (end === null && duration === null)) continue;
      const offset = containerOffset(paragraph, rates);
      const startMs = offset + begin;
      const endMs = end === null ? startMs + duration : offset + end;
      const text = cleanLines(paragraphText(paragraph, styles));
      if (text && endMs >= startMs) cues.push({ startMs, endMs, text });
    }
    return sortCues(cues);
  }

  function parseSubtitles(format, text, options) {
    if (format === "webvtt") return parseWebVtt(text);
    if (format === "ttml") return parseTtml(text, options);
    throw new Error(`Unsupported subtitle format ${JSON.stringify(format)}.`);
  }

  // What a cue and a hovered line are compared by: NFC, without spaces, line
  // breaks or direction marks. Ruby readings were already left out.
  function normaliseCueText(text) {
    return String(text).normalize("NFC").replace(INVISIBLE, "").replace(/\s+/gu, "");
  }

  // Every cue active within the tolerance of `mediaTimeMs` whose text contains the line.
  function matchingCues(cues, mediaTimeMs, line, toleranceMs = MATCH_TOLERANCE_MS) {
    const key = normaliseCueText(line ?? "");
    if (!key || !Number.isFinite(mediaTimeMs)) return [];
    return cues.filter(cue => cue.startMs - toleranceMs <= mediaTimeMs && mediaTimeMs <= cue.endMs + toleranceMs
      && (cue.key ?? normaliseCueText(cue.text)).includes(key));
  }

  // The one cue the line belongs to; none when no cue or several cues match.
  function matchCue(cues, mediaTimeMs, line, toleranceMs = MATCH_TOLERANCE_MS) {
    const found = matchingCues(cues, mediaTimeMs, line, toleranceMs);
    return found.length === 1 ? found[0] : null;
  }

  // The whole cue as the note's sentence, its lines joined without a separator
  // as Japanese subtitles wrap. The match stays where the reader's sentence put
  // it; null keeps the reader's sentence when that sentence is not exactly once
  // in the cue.
  function cueSentence(cueText, sentence, matchOffset) {
    if (typeof sentence !== "string" || sentence === "" || !Number.isSafeInteger(matchOffset)) return null;
    const whole = String(cueText).split("\n").map(line => line.trim()).join("");
    const at = whole.indexOf(sentence);
    if (at < 0 || whole.includes(sentence, at + 1)) return null;
    return { sentence: whole, matchOffset: at + matchOffset };
  }

  globalThis.HDNetflixSubtitles = {
    MATCH_TOLERANCE_MS, cueSentence, matchCue, matchingCues, normaliseCueText, parseSubtitles, parseTtml, parseWebVtt,
  };
}());
