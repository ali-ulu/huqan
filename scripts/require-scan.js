'use strict';

// Load-time require scanning core for the package-closure gate (#2227).
//
// Single responsibility: statically read literal `require('./x')` calls out
// of module source and resolve them the way CommonJS would. Pure string
// scanning plus existence checks; no package inventory, no closure walk, no
// CLI report. Those stay in scripts/check-package-closure.js, which
// re-exports loadTimeRequires so existing importers keep working. This
// module is never a second authority for packaging decisions.
//
// Two read modes, because "may this require run?" has two answers:
//
//   loadTimeRequires   only module-scope requires. Used for import-graph
//                      questions where a call-graph edge is not wanted.
//   reachableRequires  module-scope requires plus literal requires inside
//                      function bodies -- anywhere in the shipped file a
//                      caller can reach. The packaging gate uses this: a
//                      require behind a CLI subcommand or an MCP tool name
//                      still runs for a real consumer, so its target must
//                      ship. Only a `try`/`catch` block is deferred, because
//                      that is the repository's deliberate guard for a
//                      repo-only dependency (server.js -> lib/http/v5-import,
//                      lib/a2a/exchange-route).
//
// A require hidden inside `try { } catch { }` is genuinely optional and is
// excluded from both modes. Everything else -- a function body, an `if`/`for`
// block, an object or class literal -- is reachable, since the file is
// present and the caller decides whether to enter.

const fs = require('node:fs');
const path = require('node:path');


/** Keywords whose parenthesised head introduces a block, not a function body. */
const BLOCK_HEADS = new Set(['if', 'for', 'while', 'switch']);

/**
 * Does the `{` just opened defer a require, for the load-time reading?
 *
 * A function body runs when something calls it, and a `try`/`catch` block is
 * the repository's deliberate guard for a repo-only dependency -- both mean
 * the require may never execute. Everything else -- an object literal, an
 * `if` or `for` block, a bare block -- is evaluated as the module loads, so a
 * require inside it is a load-time require.
 *
 * The decision is made from the token immediately before the brace, and where
 * that token is `)`, from the one before its matching `(`:
 *
 *   `=> {`                     function body        deferred
 *   `try {`                    guard                deferred
 *   `catch (e) {`              guard                deferred
 *   `function f() {` / `f() {` function body        deferred
 *   `if (x) {` / `for (…) {`   block                load-time
 *   `= {` / `, {` / `: {`      object literal       load-time
 *
 * Anything unrecognized is treated as load-time. That is the safe direction
 * for a packaging guard: it can ask for a module to be published that did not
 * strictly need to be, but it cannot wave one through that an installed
 * consumer will fail to resolve.
 *
 * @param {string[]} tokens significant tokens seen so far, in source order
 * @returns {boolean} true when the brace defers its contents
 */
function braceDefers(tokens) {
  const prev = tokens[tokens.length - 1];
  if (prev === undefined) return false;
  if (prev === '=>' || prev === 'try') return true;
  if (prev !== ')') return false;

  // Walk back to the `(` this `)` closes, then read the token in front of it.
  let depth = 0;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (tokens[i] === ')') depth += 1;
    else if (tokens[i] === '(') {
      depth -= 1;
      if (depth === 0) {
        const head = tokens[i - 1];
        if (head === 'catch') return true;
        return !BLOCK_HEADS.has(head);
      }
    }
  }
  return false;
}

/**
 * Does the `{` just opened defer a require, for the reachable reading?
 *
 * Only a `try`/`catch` block does. A function body, an `if`/`for` block and an
 * object or class literal all hold requires a caller can reach -- the file is
 * present and something decides whether to enter -- so their targets have to
 * ship. `try`/`catch` stays out because it is the documented guard for a
 * dependency this package does not publish; the require is allowed to fail and
 * the code handles it.
 *
 * @param {string[]} tokens significant tokens seen so far, in source order
 * @returns {boolean} true when the brace defers its contents
 */
function braceDefersReachable(tokens) {
  const prev = tokens[tokens.length - 1];
  if (prev === undefined) return false;
  if (prev === 'try') return true;
  if (prev !== ')') return false;

  let depth = 0;
  for (let i = tokens.length - 1; i >= 0; i -= 1) {
    if (tokens[i] === ')') depth += 1;
    else if (tokens[i] === '(') {
      depth -= 1;
      if (depth === 0) return tokens[i - 1] === 'catch';
    }
  }
  return false;
}

/**
 * Relative require specifiers that run when the module is loaded.
 *
 * The scanner steps over comments and string literals so a require mentioned
 * in prose or inside a template does not count, and keeps a stack of the
 * braces it is inside. A require counts when no brace enclosing it defers --
 * see braceDefers for which ones do.
 *
 * @param {string} src module source
 * @returns {string[]} specifiers, in source order
 */
function loadTimeRequires(src) {
  return scanRequires(src, braceDefers);
}

/**
 * Relative require specifiers a caller can reach for from this file.
 *
 * Same scan as loadTimeRequires, but only a `try`/`catch` block defers -- a
 * require inside a function body counts. This is what a packaging gate wants:
 * "may this require run for a real consumer?" is yes for anything the module
 * can reach once it is installed, however deep the call path.
 *
 * @param {string} src module source
 * @returns {string[]} specifiers, in source order
 */
function reachableRequires(src) {
  return scanRequires(src, braceDefersReachable);
}

/**
 * The shared scanner behind both readings.
 *
 * @param {string} src module source
 * @param {(tokens: string[]) => boolean} bracesDefer decides whether an opening brace defers
 * @returns {string[]} specifiers, in source order
 */
function scanRequires(src, bracesDefer) {
  const found = [];
  const deferring = [];
  const tokens = [];
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      i += 2;
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i += 1;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\') i += 1;
        i += 1;
      }
      i += 1;
      tokens.push('<string>');
      continue;
    }

    if (/[A-Za-z_$]/.test(c)) {
      let word = '';
      while (i < src.length && /[A-Za-z0-9_$]/.test(src[i])) {
        word += src[i];
        i += 1;
      }
      if (word === 'require' && deferring.every((d) => !d)) {
        const match = /^require\(\s*['"](\.[^'"]+)['"]\s*\)/.exec(src.slice(i - word.length));
        if (match) found.push(match[1]);
      }
      tokens.push(word);
      continue;
    }

    if (c === '{') deferring.push(bracesDefer(tokens));
    else if (c === '}') deferring.pop();

    if (!/\s/.test(c)) tokens.push(c === '=' && src[i + 1] === '>' ? '=>' : c);
    if (c === '=' && src[i + 1] === '>') i += 1;
    i += 1;
  }

  return found;
}

/**
 * Resolve a relative specifier the way CommonJS would, restricted to the file
 * forms this repository uses.
 *
 * @param {string} fromFile absolute path of the requiring module
 * @param {string} spec relative specifier
 * @returns {string|null} absolute path, or null when nothing resolves
 */
function resolveLocal(fromFile, spec) {
  const target = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [target, `${target}.js`, `${target}.json`, path.join(target, 'index.js')]) {
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
  }
  return null;
}

module.exports = { BLOCK_HEADS, braceDefers, braceDefersReachable, loadTimeRequires, reachableRequires, scanRequires, resolveLocal };
