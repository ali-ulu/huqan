'use strict';

/**
 * A standing audit of which ingest paths pin their source, and which are known
 * not to.
 *
 * Pinning was added to the seven adapters. That is not the same as "ingest is
 * pinned", and the difference is exactly the kind of half-claim this repository
 * keeps finding in itself: a property that holds on the paths someone looked at,
 * stated as though it held everywhere.
 *
 * So this file enumerates every path that builds provenance and classifies it.
 * A path that starts pinning breaks the gap assertion below and has to be moved
 * into the covered list deliberately, rather than the list quietly going stale.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');

/** Every non-test source file that constructs provenance for an ingest. */
const PROVENANCE_PATHS = [
  'adapters/git-log-adapter.js',
  'adapters/github-adapter.js',
  'adapters/http-adapter.js',
  'adapters/json-adapter.js',
  'adapters/markdown-adapter.js',
  'adapters/pdf-adapter.js',
  'adapters/yaml-adapter.js',
  'lib/background-provenance.js',
  'lib/conflict-detector.js',
  'lib/github-connector.js',
  'lib/reviewed-external-graph-execution.js',
  'plugins/repo-memory.js',
];

/**
 * Paths that ingest external content and record a content hash for it.
 */
const PINNED = new Set([
  'adapters/git-log-adapter.js',
  'adapters/github-adapter.js',
  'adapters/http-adapter.js',
  'adapters/json-adapter.js',
  'adapters/markdown-adapter.js',
  'adapters/pdf-adapter.js',
  'adapters/yaml-adapter.js',
]);

/**
 * Paths that do not pin, each with the reason.
 *
 * Two different reasons, and the difference matters. A path that records no
 * external content has nothing to pin and is complete as it stands. A path that
 * does record external content and still does not pin is an open gap, and
 * saying so here is the point of the file.
 */
const NOT_PINNED = {
  'lib/background-provenance.js':
    'builds provenance for the kernel\'s own writes and for the plugin edge '
    + 'surface. It originates no external content, so it has nothing of its own '
    + 'to pin -- but it does forward a caller\'s pin through '
    + 'provenanceFieldsFrom, which is what carries company-brain API ingest.',
  'lib/conflict-detector.js':
    'records a conflict between claims already in the graph. No external content '
    + 'is read, so there is nothing to pin.',
  'lib/reviewed-external-graph-execution.js':
    'executes a graph operation that was already reviewed; the provenance '
    + 'describes the review, not a fetched document.',
  'lib/github-connector.js':
    'OPEN GAP. Its own fetch path resolves repository content by branch and '
    + 'records no commit or content hash on the provenance it builds.',
  'plugins/repo-memory.js':
    'OPEN GAP, and narrower than it first looks. It fetches through '
    + 'adapters/github-adapter.js, so the bytes it reads are already pinned to a '
    + 'resolved commit and each file it receives carries commitSha. What is '
    + 'missing is that it records none of that: its provenance is '
    + '"repo:<owner>/<repo>:<path>" with no commit and no content hash, so the '
    + 'pin exists at fetch time and is thrown away before storage. So "company '
    + 'ingest is pinned" is true of company-brain and false of this one -- not '
    + 'because it reads a moving target, but because it does not write down '
    + 'which one it read.',
};

function sourceOf(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

function recordsContentHash(rel) {
  return /contentHash/.test(sourceOf(rel));
}

test.describe('provenance pinning coverage', () => {
  test('the audit list matches the paths that actually build provenance', () => {
    // Guards the list itself. A new ingest path that builds provenance and is
    // not listed here would otherwise be silently outside the audit.
    const dirs = ['adapters', 'lib', 'plugins'];
    const found = [];
    for (const dir of dirs) {
      const walk = (current) => {
        for (const entry of fs.readdirSync(path.join(REPO_ROOT, current), { withFileTypes: true })) {
          const rel = `${current}/${entry.name}`;
          if (entry.isDirectory()) { walk(rel); continue; }
          if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) continue;
          // The modules that *define* the provenance builders are the machinery,
          // not ingest paths that use it. Everything else that mentions a
          // builder is a caller and belongs in the audit.
          if (rel === 'lib/provenance-ingest.js') continue;
          const src = sourceOf(rel);
          if (/buildProvenance|buildConnectorProvenance/.test(src)) found.push(rel);
        }
      };
      walk(dir);
    }

    const listed = new Set(PROVENANCE_PATHS);
    const unlisted = found.filter((rel) => !listed.has(rel));
    assert.deepStrictEqual(unlisted, [],
      `these build provenance but are not in the audit list:\n  ${unlisted.join('\n  ')}`);
  });

  test('every listed path is classified exactly once', () => {
    for (const rel of PROVENANCE_PATHS) {
      const pinned = PINNED.has(rel);
      const excused = Object.prototype.hasOwnProperty.call(NOT_PINNED, rel);
      assert.ok(pinned !== excused, `${rel} is classified as both or neither`);
    }
  });

  test('every path claimed as pinned records a content hash', () => {
    const claimedButNot = [...PINNED].filter((rel) => !recordsContentHash(rel));
    assert.deepStrictEqual(claimedButNot, [],
      `listed as pinned but records no content hash:\n  ${claimedButNot.join('\n  ')}`);
  });

  test('KNOWN GAP: repo-memory and the GitHub connector still do not pin', () => {
    // Held as an assertion so that pinning them breaks this test and forces the
    // classification above to be updated in the same change, rather than the
    // gap note outliving its cause.
    for (const rel of ['plugins/repo-memory.js', 'lib/github-connector.js']) {
      assert.ok(!recordsContentHash(rel),
        `${rel} now records a content hash. Move it into PINNED above and delete `
        + 'its NOT_PINNED entry -- the gap is closed and the note is now false.');
    }
  });

  test('every unpinned path states why, and open gaps say so in those words', () => {
    for (const [rel, reason] of Object.entries(NOT_PINNED)) {
      assert.ok(reason && reason.length > 40, `${rel} has no real reason recorded`);
    }
    // The two classes must stay distinguishable: "nothing to pin" is finished
    // work, "OPEN GAP" is not, and collapsing them is how the second becomes
    // invisible.
    assert.match(NOT_PINNED['plugins/repo-memory.js'], /OPEN GAP/);
    assert.match(NOT_PINNED['lib/github-connector.js'], /OPEN GAP/);
    assert.ok(!/OPEN GAP/.test(NOT_PINNED['lib/conflict-detector.js']));
  });
});
