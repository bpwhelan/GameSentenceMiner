// The searched text's cursor (docs/search-history.md): Rubi's overlay cursor
// (bee-san/Rubi_for_vita@6b5e276 core/text_rows.c, used by shell/overlay.cpp
// input_overlay), ported to the search page's text. Left/Right go in reading
// order across the rows, Right over the word the last lookup matched
// (vjo_word_step) and Left back over up to 16 of those Rights, and stop at the
// text's first and last characters, except that a text on one row goes round
// its ends (vjo_text_row_step). Up/Down go to the displayed row above or below,
// soft-wrapped rows included, keeping the column (vjo_text_row_vertical).
// Offsets are UTF-16 indexes into the text, where Rubi's are UTF-8 bytes; the
// rows are the browser's own layout (textRows), so nothing is estimated.
// SPDX-License-Identifier: GPL-3.0-or-later

// What a move did (VJO_ROW_*): no layout to decide by, nowhere to go, moved,
// or went round a one-row text's end.
export const ROW_UNAVAILABLE = -1;
export const ROW_STAY = 0;
export const ROW_MOVED = 1;
export const ROW_WRAPPED = 2;
// How many Rights a Left retraces (VjoWordNavigation.previous).
export const WORD_HISTORY = 16;

// Rubi's japanese_letters (core/utf.c): Han, Hiragana and Katakana letters
// and letter numbers, and the combining sound marks. Punctuation is never a stop.
const JAPANESE_LETTER = /^(?:(?=[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}])[\p{L}\p{Nl}]|[\u3099\u309a])$/u;

// Whether the cursor can rest on `codePoint` (vjo_text_selectable): a
// Japanese letter with `japaneseOnly`, otherwise any visible character;
// spaces (U+3000 too), line breaks and controls never.
export function selectable(codePoint, japaneseOnly) {
  if (japaneseOnly) return JAPANESE_LETTER.test(String.fromCodePoint(codePoint));
  return codePoint > 0x20 && (codePoint < 0x7f || codePoint > 0x9f) && codePoint !== 0x3000;
}

// Each rendered character of `text` in reading order: its offset, the offset
// after it and its code point. A CR is not rendered.
function* characters(text) {
  for (let at = 0; at < text.length;) {
    const codePoint = text.codePointAt(at);
    const end = at + (codePoint > 0xffff ? 2 : 1);
    if (codePoint !== 0x0d) yield { at, end, codePoint };
    at = end;
  }
}

const stay = to => ({ result: ROW_STAY, to });

// The offset of the character before `at`: one code unit back, or two when
// the unit before `at` ends a surrogate pair (codePointAt there gives that
// low surrogate's own value).
function previousCharacter(text, at) {
  const unit = at >= 2 ? text.codePointAt(at - 1) : 0;
  return at - (unit >= 0xdc00 && unit <= 0xdfff ? 2 : 1);
}

// Whether the character at `at` carries on a word begun before it, in a
// language read word by word (`words`: the pack's word and word-internal
// characters, read as content-scan.js's wordStart reads them). A lookup from
// it starts at its word's first character (docs/languages.md 8.3), so it is
// no stop of its own.
function continuesWord(text, at, words) {
  if (words === null || at <= 0 || at >= text.length) return false;
  const back = from => previousCharacter(text, from);
  const character = from => (from < 0 ? undefined : String.fromCodePoint(text.codePointAt(from)));
  const isWord = value => value !== undefined && words.word.test(value);
  const isInternal = value => value !== undefined && words.internal !== null && words.internal.test(value);
  const here = character(at);
  const previous = character(back(at));
  if (isInternal(here)) return isWord(previous);
  return isWord(here) && (isWord(previous) || (isInternal(previous) && isWord(character(back(back(at))))));
}

// The characters the cursor can rest on (its stops), in reading order, each
// with whether a line break comes between it and the stop before it.
function* stops(text, japaneseOnly, words = null) {
  let broken = false;
  for (const { at, codePoint } of characters(text)) {
    if (codePoint === 0x0a) {
      broken = true;
    } else if (selectable(codePoint, japaneseOnly) && !continuesWord(text, at, words)) {
      yield { at, broken };
      broken = false;
    }
  }
}

// The first character the cursor can rest on at or after `from`, or null.
export function firstSelectable(text, from, japaneseOnly, words = null) {
  for (const { at } of stops(text, japaneseOnly, words)) if (at >= from) return at;
  return null;
}

// The stop a lookup from `at` starts at: `at`, or in a word the stop the
// word begins at; null when there is none.
export function stopAt(text, at, japaneseOnly, words = null) {
  let start = at;
  while (continuesWord(text, start, words)) {
    start = previousCharacter(text, start);
  }
  return firstSelectable(text, start, japaneseOnly, words) === start ? start : null;
}

// A line the cursor moves over: `text`, its layout `rows` (textRows, or null
// while it is not laid out) and `japaneseOnly`, whether only Japanese letters
// hold the cursor.

// In reading order, without the layout (vjo_text_row_step's walk): the stop a
// step goes to, null past the text's end that way, and for an end the text's
// first and last stops and whether a line break lies between them.
function readingOrder({ text, japaneseOnly, words = null }, cursor, from, direction) {
  const found = { to: null, first: null, last: null, split: false };
  for (const { at, broken } of stops(text, japaneseOnly, words)) {
    if (direction > 0 && at >= from) return { ...found, to: at };
    if (direction < 0 && at >= cursor && found.to !== null) return found;
    if (direction < 0 && at < cursor) found.to = at;
    found.split ||= found.first !== null && broken; // a line break between the first stop and this one
    found.first ??= at;
    found.last = at;
  }
  return found;
}

// Past the text's last (first) stop: round to its first (last) with `wrap`,
// only on one displayed row, which the first's and the last's cells tell.
// Without them, a line break between the two stands for a row.
function roundTheEnd(rows, { first, last, split }, cursor, direction, wrap) {
  const to = direction > 0 ? first : last;
  if (!wrap || first === null || to === cursor) return stay(cursor);
  const firstCell = rows?.cell(first);
  const lastCell = rows?.cell(last);
  if (firstCell && lastCell) return firstCell.line === lastCell.line ? { result: ROW_WRAPPED, to } : stay(cursor);
  return { result: ROW_UNAVAILABLE, to: split ? cursor : to };
}

// Left/Right in reading order (vjo_text_row_step). direction > 0: the first
// stop at or after `from` (past the cursor: the next character, or the end of
// the matched word); direction < 0: the last stop before the cursor. Past the
// text's last (first) stop the cursor stays, except that with `wrap` a text
// whose stops are all on one row goes round to its first (last). Only that end
// asks the layout. Returns { result, to }.
export function rowStep(line, cursor, from, direction, wrap) {
  if (cursor >= line.text.length || !direction) return stay(cursor);
  const found = readingOrder(line, cursor, from, direction);
  return found.to === null ? roundTheEnd(line.rows, found, cursor, direction, wrap) : { result: ROW_MOVED, to: found.to };
}

// On the nearest row above (direction < 0) or below the cursor's row with a
// stop, the stop whose cell is nearest `column`: in it, else its nearest edge,
// the earlier on a tie. In reading order the rows above end at the cursor's
// row, and the row below at the next one after it; a nearer row starts the
// choice again. Its offset, null for no such row, or ROW_UNAVAILABLE.
function nearestOnRow({ text, rows, japaneseOnly, words = null }, row, direction, column) {
  let best = null;
  for (const { at } of stops(text, japaneseOnly, words)) {
    const cell = rows.cell(at);
    if (!cell) return ROW_UNAVAILABLE;
    if (direction < 0 ? cell.line >= row : best !== null && cell.line > best.line) break;
    if (direction > 0 && cell.line <= row) continue;
    const distance = Math.max(cell.x - column, column - cell.end, 0);
    if (best === null || cell.line > best.line || distance < best.distance) best = { at, line: cell.line, distance };
  }
  return best?.at ?? null;
}

// Up (direction < 0) or Down (vjo_text_row_vertical): the nearest row above or
// below with a stop, and on it the stop nearest the column. `goal` ({ x, at })
// keeps the column while the cursor stays where Up/Down left it (at is 1 +
// that offset), so repeated moves keep it across a short row; otherwise the
// column is the middle of the cursor's cell.
export function rowVertical(line, cursor, direction, goal) {
  if (cursor >= line.text.length || !direction) return stay(cursor);
  const here = line.rows?.cell(cursor);
  if (!here) return { result: ROW_UNAVAILABLE, to: cursor };
  const column = goal.at === cursor + 1 ? goal.x : (here.x + here.end) / 2;
  const best = nearestOnRow(line, here.line, direction, column);
  if (best === ROW_UNAVAILABLE) return { result: ROW_UNAVAILABLE, to: cursor };
  if (best === null) return stay(cursor);
  goal.x = column;
  goal.at = best + 1;
  return { result: ROW_MOVED, to: best };
}

// Whether `at` starts a character rather than splitting a surrogate pair.
const boundary = (text, at) => at === 0 || at >= text.length || text.codePointAt(at - 1) <= 0xffff;

// Left/Right by word (vjo_word_step). Right goes past the matched word
// [cursor, matchedEnd), wherever it ends, and remembers where it started; Left
// goes back to the last of those, else one stop back, and forgets them. A
// pending or failed lookup passes matchedEnd 0: one character.
export function wordStep(navigation, line, cursor, matchedEnd, direction, wrap) {
  const { words } = navigation;
  const { text } = line;
  if (cursor >= text.length || !direction) return stay(cursor);
  if (direction < 0 && words.length > 0 && words.at(-1) !== cursor && words.at(-1) < text.length) {
    return { result: ROW_MOVED, to: words.pop() };
  }
  const from = direction > 0 && matchedEnd > cursor && matchedEnd <= text.length && boundary(text, matchedEnd)
    ? matchedEnd : cursor + 1;
  const step = rowStep(line, cursor, from, direction, wrap);
  if (step.to !== cursor && direction < 0) words.length = 0;
  else if (step.to !== cursor) {
    if (words.length === WORD_HISTORY) words.shift();
    words.push(cursor);
  }
  return step;
}

// One navigation per shown text: Right's history and Up/Down's column.
export const createNavigation = () => ({ words: [], goal: { x: 0, at: 0 } });

// The arrow keys over the line (vjo_text_row_key): Left/Right (dx) by word,
// which drops Up/Down's column, else Up/Down (dy) by row, which forgets
// Right's history, so Left then retraces only the Rights made since.
export function rowKey(navigation, line, cursor, matchedEnd, dx, dy) {
  if (dx) {
    navigation.goal.at = 0;
    return wordStep(navigation, line, cursor, matchedEnd, dx, true);
  }
  const step = rowVertical(line, cursor, dy, navigation.goal);
  if (step.result > 0) navigation.words.length = 0;
  return step;
}

// The layout of a rendered text node, as Rubi's renderer reports it: each
// character's cell, from the left of its glyph to its right, and its row,
// counted from the top as the browser broke them. Null while it is not laid
// out (hidden, or detached).
export function textRows(node) {
  const range = node.ownerDocument.createRange();
  const cells = new Map();
  let row = null;
  let line = -1;
  for (const { at, end, codePoint } of characters(node.data)) {
    if (codePoint === 0x0a) continue;
    range.setStart(node, at);
    range.setEnd(node, end);
    const rect = range.getClientRects()[0];
    if (!rect) continue;
    // A glyph from another font sits a little higher or lower on its row.
    if (row === null || rect.top >= row.top + row.height / 2) {
      row = rect;
      line += 1;
    }
    cells.set(at, { x: rect.left, end: rect.right, line });
  }
  return line < 0 ? null : { cell: at => cells.get(at) ?? null };
}
