/*
 * Display transforms (docs/languages.md 10.4): the step kinds a language
 * pack's `presentation.displayTransforms` may use, as the hoshidicts engine
 * contract defines them (section 6.2): case, normalize, strip, map and
 * pattern. Their class references arrive expanded from the generated
 * registry. Hosts apply them only to displayed text, never to what is looked
 * up, mined, stored or counted.
 * SPDX-License-Identifier: GPL-3.0-or-later
 */
(function (root, factory) {
  // A classic script on pages and in content scripts; an import for its
  // side effect in Node and workers.
  root.HDLanguageText = factory();
}(globalThis, function () {
  "use strict";

  const compiled = new WeakMap();
  function regex(step, key, flags) {
    let cache = compiled.get(step);
    if (!cache) compiled.set(step, cache = {});
    cache[key] ??= new RegExp(step[key], flags);
    return cache[key];
  }

  // JavaScript's full case mappings, which the engine reproduces (6.2).
  function applyCase(text, mode) {
    const [first = "", ...rest] = Array.from(text);
    if (mode === "lower") return text.toLowerCase();
    if (mode === "upper") return text.toUpperCase();
    if (mode === "upperFirst") return first.toUpperCase() + rest.join("");
    if (mode === "lowerFirst") return first.toLowerCase() + rest.join("");
    throw new Error(`Unknown case mode: ${mode}`);
  }

  function applyNormalize(text, step) {
    if (typeof step.within !== "string") return text.normalize(step.normalize);
    const within = regex(step, "within", "u");
    let output = "", run = "";
    for (const character of text) {
      if (within.test(character)) run += character;
      else {
        output += run.normalize(step.normalize) + character;
        run = "";
      }
    }
    return output + run.normalize(step.normalize);
  }

  // Literal replacement, longest key first, scanning left to right.
  function applyMap(text, step) {
    const keys = Object.keys(step.map).filter(Boolean).sort((left, right) => right.length - left.length);
    const at = step.at ?? "all";
    if (at === "start") {
      const key = keys.find(candidate => text.startsWith(candidate));
      return key === undefined ? text : step.map[key] + text.slice(key.length);
    }
    if (at === "end") {
      const key = keys.find(candidate => text.endsWith(candidate));
      return key === undefined ? text : text.slice(0, text.length - key.length) + step.map[key];
    }
    if (at !== "all" && at !== "first" && at !== "last") throw new Error(`Unknown map position: ${at}`);
    const matches = [];
    for (let index = 0; index < text.length;) {
      const key = keys.find(candidate => text.startsWith(candidate, index));
      if (key === undefined) {
        index += text.codePointAt(index) > 0xffff ? 2 : 1;
        continue;
      }
      matches.push([index, key]);
      index += key.length;
    }
    const chosen = at === "first" ? matches.slice(0, 1) : at === "last" ? matches.slice(-1) : matches;
    let output = "", position = 0;
    for (const [index, key] of chosen) {
      output += text.slice(position, index) + step.map[key];
      position = index + key.length;
    }
    return output + text.slice(position);
  }

  // The 7.6 dialect: JavaScript without the u flag, so `.` and negated
  // classes match one UTF-16 unit as std::wregex does in the engine.
  function applyPattern(text, step) {
    const pattern = regex(step, "pattern", step.global ? "g" : "");
    const replace = typeof step.replace === "string" ? step.replace : "";
    let output = text.replace(pattern, replace);
    for (let round = 1; step.repeat === true && round < 16; round += 1) {
      const next = output.replace(pattern, replace);
      if (next === output) break;
      output = next;
    }
    return output;
  }

  function applyStep(text, step) {
    if (typeof step?.case === "string") return applyCase(text, step.case);
    if (typeof step?.normalize === "string") return applyNormalize(text, step);
    if (typeof step?.strip === "string") return text.replace(regex(step, "strip", "gu"), "");
    if (step?.map && typeof step.map === "object") return applyMap(text, step);
    if (typeof step?.pattern === "string") return applyPattern(text, step);
    throw new Error(`Unsupported display transform step: ${JSON.stringify(step)}`);
  }

  function applySteps(steps, text) {
    let output = String(text ?? "");
    for (const step of Array.isArray(steps) ? steps : []) output = applyStep(output, step);
    return output;
  }

  return { applySteps };
}));
