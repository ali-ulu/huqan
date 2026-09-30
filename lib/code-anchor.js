'use strict';

/**
 * Content-anchored code locations (#3199).
 *
 * A line number is not a location. It is an offset that happens to be right at
 * the moment it is written: any unrelated edit above it moves the code and the
 * number silently points somewhere else. Source-contract tests in this
 * repository pin line numbers, so they go red for edits that did not touch what
 * they were guarding, and the next HUQAN Coder step -- the contract object, a
 * versioned behaviour invariant that has to outlive the implementation -- needs
 * to point at code that will keep moving.
 *
 * An anchor replaces the number with the content:
 *
 *   { path, snippet, snippetHash }
 *
 * and resolves it to a line range at read time. The prior art is
 * OpenCodeReview's diff resolver: the model never produces a location, it
 * produces a quoted snippet, and the location is recovered deterministically.
 * This is that idea natively in JS, with the same refusal to guess.
 *
 * ## Three answers, and two of them are not a location
 *
 *   resolved   exactly one match; here is the line range
 *   ambiguous  more than one match; here is how many, and no line number
 *   missing    no match
 *
 * `ambiguous` and `missing` are never collapsed into a line number. A resolver
 * that picked the first match would be right most of the time, and "most of the
 * time" is how a line-pinned contract fails: silently, in the direction of
 * looking like it still works. There is also no LLM fallback here -- re-asking
 * a model to re-extract the snippet would move the guess into a second place.
 * `missing` is the honest answer.
 *
 * ## This is a content claim, not a byte claim
 *
 * Normalization is explicit, and the reason is the derivation-record lesson
 * (lib/coder/derivation-record.js): git rewrites line endings on checkout, so
 * the same commit is CRLF on a Windows working tree and LF in the blob. A
 * byte-exact anchor would certify the checkout policy of whoever wrote it, and
 * a Windows-authored anchor would never match in CI. So:
 *
 *   - line endings normalize to LF;
 *   - each line is trimmed, so indentation and a reindent do not break an
 *     anchor;
 *   - blank lines at the edges of the snippet are dropped, because a snippet
 *     pasted from a file tends to carry them and they are not content;
 *   - blank lines *inside* the snippet are kept, because there they separate
 *     two things the author meant to keep apart.
 *
 * The cost is real and worth stating: an edit that only reindents verifies as
 * the same anchor. That is the right trade for the same reason it is in the
 * derivation record -- those bytes are not the change's to control.
 *
 * Line numbers are reported in the file's own coordinates (1-based, counting
 * every line, blank ones included), which is what a person opening the file
 * expects. The file is trimmed for matching but never has lines dropped, so the
 * mapping back is the identity.
 */

const crypto = require('node:crypto');

/** sha256 of the UTF-8 bytes, the same digest the receipt layer computes. */
function sha256Hex(input) {
  return crypto.createHash('sha256').update(input, 'utf8').digest('hex');
}

const CODE_ANCHOR_STATUS = Object.freeze({
  RESOLVED: 'resolved',
  AMBIGUOUS: 'ambiguous',
  MISSING: 'missing',
});

/** Normalized lines of `text`: LF endings, trimmed, edge blanks dropped. */
function normalizeLines(text) {
  if (typeof text !== 'string') return [];
  const lines = text.replace(/\r\n/gu, '\n').split('\n').map(line => line.trim());
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === '') start += 1;
  while (end > start && lines[end - 1] === '') end -= 1;
  return lines.slice(start, end);
}

/** The content claim: a digest of the normalized snippet, stable across checkouts. */
function hashSnippet(snippet) {
  return sha256Hex(normalizeLines(snippet).join('\n'));
}

function fail(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * Build an anchor from a path and a snippet.
 *
 * The snippet must normalize to at least one line: an anchor over nothing would
 * match every position in every file, which is the ambiguity this module exists
 * to refuse rather than to produce.
 *
 * @param {{path?: string, snippet?: string}} input
 * @returns {{path: string, snippet: string, snippetHash: string}}
 * @throws on a missing path or a snippet with no content.
 */
function buildCodeAnchor(input = {}) {
  const path = typeof input.path === 'string' ? input.path.trim() : '';
  if (!path) {
    throw fail('CODE_ANCHOR_PATH_REQUIRED', 'An anchor needs the path it was taken from.');
  }
  const snippet = typeof input.snippet === 'string' ? input.snippet : '';
  const lines = normalizeLines(snippet);
  if (lines.length === 0) {
    throw fail('CODE_ANCHOR_SNIPPET_REQUIRED', 'An anchor needs a snippet with at least one non-blank line.');
  }
  return { path, snippet, snippetHash: hashSnippet(snippet) };
}

/** All start indices in `fileLines` where `snippetLines` matches consecutively. */
function matchStarts(fileLines, snippetLines) {
  const starts = [];
  const last = fileLines.length - snippetLines.length;
  for (let start = 0; start <= last; start += 1) {
    let offset = 0;
    while (offset < snippetLines.length && fileLines[start + offset] === snippetLines[offset]) offset += 1;
    if (offset === snippetLines.length) starts.push(start);
  }
  return starts;
}

/**
 * Resolve an anchor against one file's content.
 *
 * @param {{path?: string, snippet?: string}} anchor
 * @param {string} content the file's text
 * @param {{path?: string}} [where] the path `content` came from, reported back
 * @returns {{status: string, path: string, snippetHash: string, lineStart: number|null, lineEnd: number|null, matchCount: number}}
 */
function resolveCodeAnchor(anchor, content, where = {}) {
  const built = buildCodeAnchor(anchor);
  const path = typeof where.path === 'string' && where.path ? where.path : built.path;
  const snippetLines = normalizeLines(built.snippet);
  const starts = matchStarts(normalizeLines(content), snippetLines);

  if (starts.length === 0) {
    return {
      status: CODE_ANCHOR_STATUS.MISSING,
      path,
      snippetHash: built.snippetHash,
      lineStart: null,
      lineEnd: null,
      matchCount: 0,
    };
  }

  if (starts.length > 1) {
    // Deliberately no line number: choosing one would be the guess.
    return {
      status: CODE_ANCHOR_STATUS.AMBIGUOUS,
      path,
      snippetHash: built.snippetHash,
      lineStart: null,
      lineEnd: null,
      matchCount: starts.length,
    };
  }

  const start = starts[0];
  return {
    status: CODE_ANCHOR_STATUS.RESOLVED,
    path,
    snippetHash: built.snippetHash,
    lineStart: start + 1,
    lineEnd: start + snippetLines.length,
    matchCount: 1,
  };
}

/**
 * Resolve an anchor across several files, the way OpenCodeReview relocates a
 * finding across the diff: the anchor's own path first, then the others in a
 * deterministic order, so a moved block is still found without the anchor
 * having to be rewritten.
 *
 * The primary path is tried first and wins outright when it resolves, so a
 * snippet that also appears in a sibling file does not turn the anchor
 * ambiguous. Relocation only applies when the primary file has no match at all.
 *
 * @param {{path?: string, snippet?: string}} anchor
 * @param {Record<string, string>} files path -> content
 * @returns {{status: string, path: string, snippetHash: string, lineStart: number|null, lineEnd: number|null, matchCount: number, relocated: boolean}}
 */
function resolveCodeAnchorInFiles(anchor, files = {}) {
  const built = buildCodeAnchor(anchor);
  const primary = resolveCodeAnchor(built, files[built.path], { path: built.path });
  if (primary.status !== CODE_ANCHOR_STATUS.MISSING) {
    return { ...primary, relocated: false };
  }

  const others = Object.keys(files).filter(path => path !== built.path).sort();
  for (const path of others) {
    const result = resolveCodeAnchor(built, files[path], { path });
    if (result.status === CODE_ANCHOR_STATUS.RESOLVED) {
      return { ...result, relocated: true };
    }
    if (result.status === CODE_ANCHOR_STATUS.AMBIGUOUS) {
      return { ...result, relocated: true };
    }
  }

  return { ...primary, relocated: false };
}

module.exports = {
  CODE_ANCHOR_STATUS,
  buildCodeAnchor,
  hashSnippet,
  normalizeLines,
  resolveCodeAnchor,
  resolveCodeAnchorInFiles,
};
