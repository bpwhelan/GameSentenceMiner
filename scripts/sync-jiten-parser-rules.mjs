// Imports data, never executes upstream C#. See the vendored README for credits.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const constructors = {
  RewriteRule: ['Id', 'Phase', 'Match', 'Replace', 'Prev', 'Next', 'Window', 'Guard'],
  TokenPattern: ['Text', 'TextAnyOf', 'TextStartsWith', 'TextEndsWith', 'Pos', 'DictFormAnyOf', 'NormalizedFormAnyOf', 'ReadingPrefix', 'NotReadingPrefix', 'RequireUnpinned'],
  TokenTemplate: ['Text', 'DictForm', 'NormalizedForm', 'Pos', 'PosSection', 'Reading', 'Pin', 'PinReadingIndex', 'HardPin', 'RecoverConjugations'],
  ContextCond: ['TextAnyOf', 'TextEndsWithAnyOf', 'TextStartsWithAnyOf', 'PosAnyOf', 'ClauseBoundary', 'Negate'],
  WindowCond: ['From', 'To', 'TextAnyOf', 'PosAnyOf', 'Negate'],
  LookupGuard: ['Kind', 'Pattern', 'Rank'],
};
const enums = {
  RewritePhase: ['Early', 'Late', 'Cleanup', 'Reading'],
  LookupGuardKind: ['CompoundExists', 'NonNameCompoundExists', 'CompoundAbsent', 'FrequencyRankUnder'],
  PartOfSpeech: ['Unknown', 'Noun', 'Verb', 'IAdjective', 'Adverb', 'Particle', 'Conjunction', 'Auxiliary', 'Adnominal', 'Interjection', 'Symbol', 'Prefix', 'Filler', 'Name', 'Pronoun', 'NaAdjective', 'Suffix', 'CommonNoun', 'SupplementarySymbol', 'BlankSpace', 'Expression', 'NominalAdjective', 'Numeral', 'PrenounAdjectival', 'Counter', 'AdverbTo', 'NounSuffix'],
  PartOfSpeechSection: ['None', 'SentenceEndingParticle'],
};

export function parseRewriteTable(source) {
  const anchor = /private\s+static\s+readonly\s+RewriteRule\[\]\s+RewriteRulesTable\s*=/g;
  const match = anchor.exec(source);
  if (!match || anchor.exec(source)) throw new Error('Expected exactly one RewriteRulesTable declaration');
  let cursor = match.index + match[0].length;
  function peek() {
    const trivia = /^(?:\s+|\/\/[^\n]*(?:\n|$)|\/\*[\s\S]*?\*\/)+/.exec(source.slice(cursor));
    if (trivia) cursor += trivia[0].length;
    const token = /^(?:"(?:[^"\\]|\\.)*"|-?\d+|[A-Za-z_]\w*|[\[\](),:.;=])/.exec(source.slice(cursor));
    if (!token) throw new Error(`Unsupported C# syntax at ${cursor}: ${source.slice(cursor, cursor + 35)}`);
    return token[0];
  }
  function take(expected) {
    const token = peek();
    if (expected !== undefined && token !== expected) throw new Error(`Expected ${expected}, got ${token} at ${cursor}`);
    cursor += token.length;
    return token;
  }
  function value() {
    const token = peek();
    if (token === '[') {
      take('[');
      const result = [];
      while (peek() !== ']') {
        result.push(value());
        if (peek() !== ']') take(',');
      }
      take(']');
      return result;
    }
    if (token === 'new') {
      take('new');
      const name = take();
      if (!Object.hasOwn(constructors, name)) throw new Error(`Unsupported constructor ${name}`);
      const fields = constructors[name];
      take('(');
      const result = {};
      let position = 0;
      let named = false;
      while (peek() !== ')') {
        const saved = cursor;
        const candidate = take();
        let key;
        if (/^[A-Za-z_]\w*$/.test(candidate) && peek() === ':') {
          key = candidate;
          if (!fields.includes(key)) throw new Error(`Unknown ${name} field ${key}`);
          take(':');
          named = true;
        } else {
          cursor = saved;
          if (named || position >= fields.length) throw new Error(`Unsupported positional argument in ${name}`);
          key = fields[position++];
        }
        key = key[0].toLowerCase() + key.slice(1);
        if (Object.hasOwn(result, key)) throw new Error(`Duplicate ${name} field ${key}`);
        result[key] = value();
        if (peek() !== ')') take(',');
      }
      take(')');
      return result;
    }
    if (token.startsWith('"')) return JSON.parse(take());
    if (/^-?\d+$/.test(token)) return Number(take());
    if (token === 'true' || token === 'false' || token === 'null') return JSON.parse(take());
    if (Object.hasOwn(enums, token)) {
      take(); take('.');
      const member = take();
      if (!enums[token].includes(member)) throw new Error(`Unsupported ${token}.${member}`);
      return member;
    }
    throw new Error(`Unsupported value ${token} at ${cursor}`);
  }
  const rules = value();
  take(';');
  validateRules(rules);
  return rules;
}

export function validateRules(rules) {
  if (!Array.isArray(rules) || rules.length === 0) throw new Error('Empty rewrite table');
  const ids = new Set();
  for (const rule of rules) {
    if (typeof rule.id !== 'string' || !rule.id || ids.has(rule.id)) throw new Error(`Duplicate or missing rule id: ${rule.id}`);
    ids.add(rule.id);
    if (!enums.RewritePhase.includes(rule.phase)) throw new Error(`Unsupported phase: ${rule.phase}`);
    if (!Array.isArray(rule.match) || rule.match.length < 1 || rule.match.length > 3 || !Array.isArray(rule.replace) || rule.replace.length < 1) throw new Error(`Invalid arity: ${rule.id}`);
    for (const output of rule.replace) {
      if (typeof output.text !== 'string' || (output.text && typeof output.reading !== 'string')) throw new Error(`Missing output text/reading: ${rule.id}`);
    }
    if (rule.match.every(p => typeof p.text === 'string') && rule.replace.every(p => p.text.length)) {
      if (rule.match.map(p => p.text).join('') !== rule.replace.map(p => p.text).join('')) throw new Error(`Surface text is not conserved: ${rule.id}`);
    }
  }
}

export async function syncRules(checkout) {
  const git = (...args) => execFileSync('git', ['-C', path.resolve(checkout), ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
  if (git('status', '--porcelain').trim()) throw new Error('Use a clean Jiten checkout');
  const commit = git('rev-parse', 'HEAD').trim();
  const sourcePath = 'Jiten.Parser/Stages/MorphologicalAnalyser.RewriteRules.cs';
  const source = git('show', `HEAD:${sourcePath}`);
  const license = git('show', 'HEAD:LICENSE');
  if (!license.includes('Apache License') || !license.includes('Version 2.0')) throw new Error('Upstream license changed; review before importing');
  // A newly added NOTICE needs review and preservation, not a silent license update.
  if (git('ls-tree', '--name-only', 'HEAD').split(/\r?\n/).some(name => /^notice(?:\.|$)/i.test(name))) throw new Error('Upstream has a NOTICE file; review and preserve it before updating this importer');
  const rules = parseRewriteTable(source);
  const manifest = {
    repository: 'https://github.com/Sirush/Jiten', commit, sourcePath,
    sourceSha256: createHash('sha256').update(source).digest('hex'),
    license: 'Apache-2.0', ruleCount: rules.length,
    guardedRules: rules.filter(rule => rule.guard).map(rule => rule.id),
  };
  const bundle = {
    notice: 'Derived from Jiten by Sirush and contributors (Apache-2.0). GSM converts the C# table to JSON; see README.md and LICENSE.',
    upstreamCommit: commit, rules,
  };
  const destination = fileURLToPath(new URL('../GSM_Overlay/third_party/jiten-parser/', import.meta.url));
  await fs.mkdir(path.join(destination, 'upstream'), { recursive: true });
  await fs.writeFile(path.join(destination, 'upstream', 'MorphologicalAnalyser.RewriteRules.cs'), source);
  await fs.writeFile(path.join(destination, 'LICENSE'), license);
  await fs.writeFile(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  await fs.writeFile(path.join(destination, 'token-rewrite-rules.json'), JSON.stringify(bundle, null, 2) + '\n');
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 3) throw new Error('Usage: node scripts/sync-jiten-parser-rules.mjs <clean-Jiten-checkout>');
  const result = await syncRules(process.argv[2]);
  console.log(`Imported ${result.ruleCount} Jiten rules at ${result.commit}; ${result.guardedRules.length} require JMdict lookups.`);
}
