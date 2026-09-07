'use strict';

/**
 * Finds user-visible copy a script writes with no catalogue key.
 *
 * This is the direction an unused-key count cannot see: if a string was never
 * translated, there is no catalogue entry whose absence could give it away.
 *
 * A regex sweep is not good enough here. The dashboard is one dense line of
 * template literals, and a pattern that tries to delete `T('key', …)` spans
 * before looking at what is left will happily let a backtick alternative run
 * past the end of the call and swallow real offenders with it — which is how
 * the first version of this check reported a confident, wrong zero.
 *
 * So the source is tokenised instead: every string literal is located exactly,
 * including the code inside a template literal's `${…}` holes, and a literal
 * counts as wired only when it sits in the fallback position of a T()/M() call
 * or an `f:` message field.
 */

const OPENERS = new Set(["'", '"', '`']);

/**
 * Walks source and returns every string literal as
 * `{ quote, start, end, text }`, where `text` is the raw literal body.
 * Template holes are walked as code, so literals nested inside them are found.
 */
function stringLiterals(source) {
  const found = [];
  let i = 0;

  function readString(quote, from) {
    let j = from + 1;
    let body = '';
    while (j < source.length) {
      const ch = source[j];
      if (ch === '\\') { body += source.slice(j, j + 2); j += 2; continue; }
      if (quote === '`' && ch === '$' && source[j + 1] === '{') {
        const hole = readHole(j + 2);
        body += ' ';
        j = hole;
        continue;
      }
      if (ch === quote) { found.push({ quote, start: from, end: j, text: body }); return j + 1; }
      body += ch;
      j += 1;
    }
    return j;
  }

  /** Walks a `${ … }` hole as code and returns the index just past its `}`. */
  function readHole(from) {
    let j = from;
    let depth = 1;
    while (j < source.length && depth > 0) {
      const ch = source[j];
      if (ch === '/' && source[j + 1] === '/') { while (j < source.length && source[j] !== '\n') j += 1; continue; }
      if (ch === '/' && source[j + 1] === '*') { const close = source.indexOf('*/', j + 2); j = close === -1 ? source.length : close + 2; continue; }
      if (ch === '/' && regexCanStartAt(j)) { j = readRegex(j); continue; }
      if (OPENERS.has(ch)) { j = readString(ch, j); continue; }
      if (ch === '{') depth += 1;
      else if (ch === '}') depth -= 1;
      j += 1;
    }
    return j;
  }

  /**
   * Skips a regular-expression literal. Without this the tokeniser loses sync
   * on ordinary code like `.replace(/'/g, '&#39;')`: the quote inside the
   * pattern opens a string that swallows the rest of the file, and everything
   * after it is mis-read. That is not hypothetical — it is what made the first
   * version of this scanner report a confident zero.
   */
  function readRegex(from) {
    let j = from + 1;
    let inClass = false;
    while (j < source.length) {
      const ch = source[j];
      if (ch === '\\') { j += 2; continue; }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) { j += 1; break; }
      else if (ch === '\n') return from + 1; // not a regex after all
      j += 1;
    }
    while (j < source.length && /[a-z]/.test(source[j])) j += 1; // flags
    return j;
  }

  /** A `/` opens a regex only where a value may begin, never after one. */
  function regexCanStartAt(index) {
    for (let k = index - 1; k >= 0; k -= 1) {
      const ch = source[k];
      if (/\s/.test(ch)) continue;
      return '(,=:[!&|?{};+-*%^~<>'.includes(ch) || /\breturn$|\btypeof$|\bcase$|\bin$|\bof$/.test(source.slice(Math.max(0, k - 7), k + 1));
    }
    return true;
  }

  while (i < source.length) {
    const ch = source[i];
    if (ch === '/' && source[i + 1] === '/') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (ch === '/' && source[i + 1] === '*') { const close = source.indexOf('*/', i + 2); i = close === -1 ? source.length : close + 2; continue; }
    if (ch === '/' && regexCanStartAt(i)) { i = readRegex(i); continue; }
    if (OPENERS.has(ch)) { i = readString(ch, i); continue; }
    i += 1;
  }
  return found;
}

/** True when the literal sits where a catalogue lookup keeps its fallback. */
function isFallbackArgument(source, literal) {
  const before = source.slice(Math.max(0, literal.start - 90), literal.start);
  return /(?:[^A-Za-z0-9_$](?:T|M)\('[A-Za-z0-9_.]+',\s*|\bf:\s*|(?:title|hint|cta):\s*)$/.test(before);
}

const IGNORE = /^(Content-Type|Bearer |Authorization|DOMContentLoaded|SHA-|application\/|text\/)/;

/** True when the text reads like something a person is meant to read. */
function looksLikeCopy(text) {
  const value = text.trim();
  if (value.length < 6) return false;
  if (!/^[A-Z]/.test(value)) return false;         // UI copy is capitalised
  if (/^[A-Z0-9_ -]+$/.test(value)) return false;  // protocol-ish tokens
  if (/^https?:|^\//.test(value)) return false;    // urls and routes
  if (/[{}$\\]/.test(value)) return false;         // interpolation leftovers
  if (!/[ .]/.test(value)) return false;           // a single bare word
  if (IGNORE.test(value)) return false;
  return true;
}

/**
 * Copy the script renders that no catalogue key covers.
 * Quoted literals are checked directly; a template literal's own text is
 * checked for the `>copy<` segments the dashboard builds its markup from.
 */
function unkeyedCopy(source) {
  const found = new Set();
  for (const literal of stringLiterals(source)) {
    if (isFallbackArgument(source, literal)) continue;
    if (literal.quote === '`') {
      for (const m of literal.text.matchAll(/>([^<>]+)</g)) {
        if (looksLikeCopy(m[1])) found.add(m[1].trim());
      }
      continue;
    }
    if (looksLikeCopy(literal.text)) found.add(literal.text.trim());
  }
  return [...found].sort();
}

module.exports = { unkeyedCopy, stringLiterals };
