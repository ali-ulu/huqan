'use strict';

/**
 * Content-anchored code locations (#3199).
 *
 * The point of an anchor is that it survives edits that do not touch the code
 * it names, and that it refuses to produce a location when it cannot be sure.
 * The tests below are written against those two claims: the drift cases (a
 * block moved, a file reindented, a checkout that rewrote line endings) must
 * still resolve, and the two ways a resolver lies -- picking one of several
 * matches, or reporting "not found" as a line number -- must not happen.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  CODE_ANCHOR_STATUS,
  buildCodeAnchor,
  hashSnippet,
  normalizeLines,
  resolveCodeAnchor,
  resolveCodeAnchorInFiles,
} = require('../lib/code-anchor');

const FILE = [
  "'use strict';",
  '',
  'function add(a, b) {',
  '  return a + b;',
  '}',
  '',
  'function sub(a, b) {',
  '  return a - b;',
  '}',
  '',
].join('\n');

describe('code anchor', () => {
  it('resolves a snippet to the line range it occupies', () => {
    const result = resolveCodeAnchor(
      { path: 'lib/math.js', snippet: 'function sub(a, b) {\n  return a - b;\n}' },
      FILE,
    );

    assert.equal(result.status, CODE_ANCHOR_STATUS.RESOLVED);
    assert.equal(result.lineStart, 7);
    assert.equal(result.lineEnd, 9);
    assert.equal(result.matchCount, 1);
  });

  it('survives an unrelated edit above the anchored code', () => {
    const anchor = buildCodeAnchor({ path: 'lib/math.js', snippet: 'return a - b;' });
    const before = resolveCodeAnchor(anchor, FILE);
    const after = resolveCodeAnchor(anchor, `// a new header line\n\n${FILE}`);

    assert.equal(before.lineStart, 8);
    // The whole point: the line moved, the anchor did not.
    assert.equal(after.lineStart, 10);
    assert.equal(after.status, CODE_ANCHOR_STATUS.RESOLVED);
  });

  it('survives a reindent and a CRLF checkout, because it is a content claim', () => {
    const anchor = buildCodeAnchor({ path: 'lib/math.js', snippet: 'function sub(a, b) {\nreturn a - b;\n}' });
    const reindented = FILE.split('\n').map(line => `    ${line}`).join('\n');
    const crlf = FILE.replace(/\n/gu, '\r\n');

    // Both normalize to the same lines: indentation is not content, and git
    // rewrites line endings on checkout, so a byte-exact anchor would certify
    // the checkout policy of whoever wrote it.
    assert.equal(resolveCodeAnchor(anchor, reindented).status, CODE_ANCHOR_STATUS.RESOLVED);
    assert.equal(resolveCodeAnchor(anchor, crlf).status, CODE_ANCHOR_STATUS.RESOLVED);
    assert.equal(hashSnippet(anchor.snippet), hashSnippet('function sub(a, b) {\r\n\treturn a - b;\r\n}'));
  });

  it('reports ambiguity instead of choosing one of several matches', () => {
    const content = 'const x = 1;\nconst x = 1;\n';
    const result = resolveCodeAnchor({ path: 'lib/dup.js', snippet: 'const x = 1;' }, content);

    assert.equal(result.status, CODE_ANCHOR_STATUS.AMBIGUOUS);
    assert.equal(result.matchCount, 2);
    // A first-match-wins resolver would be right most of the time, and "most
    // of the time" is how a line-pinned contract fails: silently.
    assert.equal(result.lineStart, null);
    assert.equal(result.lineEnd, null);
  });

  it('reports missing rather than guessing, with no LLM fallback', () => {
    const result = resolveCodeAnchor({ path: 'lib/math.js', snippet: 'function mul(a, b) {' }, FILE);

    assert.equal(result.status, CODE_ANCHOR_STATUS.MISSING);
    assert.equal(result.matchCount, 0);
    assert.equal(result.lineStart, null);
  });

  it('keeps blank lines inside a snippet but drops the edges', () => {
    const anchor = buildCodeAnchor({
      path: 'lib/math.js',
      snippet: '\n\nfunction add(a, b) {\n\n  return a + b;\n}\n\n',
    });

    // The interior blank is content the author kept, so it stays and the anchor
    // is *not* the same as one without it. The leading and trailing blanks are
    // what a copy-paste picks up, and they are dropped.
    assert.deepEqual(normalizeLines(anchor.snippet), ['function add(a, b) {', '', 'return a + b;', '}']);
    assert.notEqual(hashSnippet(anchor.snippet), hashSnippet('function add(a, b) {\n  return a + b;\n}'));

    // Against content that does carry the interior blank, it resolves.
    const spaced = 'function add(a, b) {\n\n  return a + b;\n}\n';
    assert.equal(resolveCodeAnchor(anchor, spaced).status, CODE_ANCHOR_STATUS.RESOLVED);
    assert.equal(resolveCodeAnchor(anchor, FILE).status, CODE_ANCHOR_STATUS.MISSING);
  });

  it('relocates to another file only when the anchor path has no match at all', () => {
    const anchor = buildCodeAnchor({ path: 'lib/old-name.js', snippet: 'return a - b;' });
    const moved = resolveCodeAnchorInFiles(anchor, {
      'lib/old-name.js': "'use strict';\n",
      'lib/new-name.js': FILE,
    });

    assert.equal(moved.status, CODE_ANCHOR_STATUS.RESOLVED);
    assert.equal(moved.path, 'lib/new-name.js');
    assert.equal(moved.relocated, true);

    // When the primary path does resolve, a snippet that also appears elsewhere
    // must not turn the anchor ambiguous: the anchor names its own file.
    const inPlace = resolveCodeAnchorInFiles(
      buildCodeAnchor({ path: 'lib/math.js', snippet: 'return a + b;' }),
      { 'lib/math.js': FILE, 'lib/other.js': FILE },
    );
    assert.equal(inPlace.status, CODE_ANCHOR_STATUS.RESOLVED);
    assert.equal(inPlace.path, 'lib/math.js');
    assert.equal(inPlace.relocated, false);
  });

  it('refuses to build an anchor with no path or no content', () => {
    assert.throws(
      () => buildCodeAnchor({ snippet: 'x' }),
      err => err.code === 'CODE_ANCHOR_PATH_REQUIRED',
    );
    // An anchor over nothing would match every position in every file, which
    // is the ambiguity this module exists to refuse rather than to produce.
    assert.throws(
      () => buildCodeAnchor({ path: 'lib/math.js', snippet: '   \n\n' }),
      err => err.code === 'CODE_ANCHOR_SNIPPET_REQUIRED',
    );
  });
});
