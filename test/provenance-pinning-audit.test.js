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
  'lib/connectors/entry-ingest-flow.js',
  'lib/github-connector.js',
  'plugins/repo-memory.js',
  'lib/repo-file-pin.js',
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
  // Closed after #671, each for a different reason -- see the notes that used to
  // sit in NOT_PINNED and are preserved in the commit that moved them.
  'lib/github-connector.js',
  'plugins/repo-memory.js',
  // Where repo-memory's pinning lives, after the file-size ratchet required it
  // to move out of the plugin. It computes the hash, so it is classified here
  // rather than excused as "nothing to pin".
  'lib/repo-file-pin.js',
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
  'lib/connectors/entry-ingest-flow.js':
    'is the shared walk the entry-based connectors in plugins/repo-memory.js '
    + 'run. It reads nothing itself: every entry, including its sourceRef, is '
    + 'handed to it by an adapter that already pinned the content, so it has '
    + 'nothing of its own to pin and forwards what it was given.',
};

function sourceOf(rel) {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/**
 * Whether a path records a content hash, following one level of local require.
 *
 * A path that extracts its pinning into a module still pins -- repo-memory does
 * exactly that, because the file-size ratchet required it. Reading only the file
 * itself would report that as an open gap and be wrong.
 */
function recordsContentHash(rel) {
  const source = sourceOf(rel);
  if (/contentHash/.test(source)) return true;

  for (const match of source.matchAll(/require\('(\.[^']+)'\)/g)) {
    const target = path.resolve(path.dirname(path.join(REPO_ROOT, rel)), match[1]);
    const candidate = target.endsWith('.js') ? target : `${target}.js`;
    if (!fs.existsSync(candidate)) continue;
    if (/contentHash/.test(fs.readFileSync(candidate, 'utf8'))) return true;
  }
  return false;
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

  test('the two paths that were open gaps now pin, each in its own way', () => {
    // This case was the KNOWN GAP guard. It fired the moment both paths were
    // pinned, which is what it was for, and is now the positive assertion in its
    // place -- the classification and the code moved in the same change.
    //
    // The two fixes are not the same fix, and asserting them together would hide
    // that. repo-memory records a commit it already held; the connector records
    // a version its caller states, because it fetches nothing and cannot resolve
    // one itself.
    for (const rel of ['plugins/repo-memory.js', 'lib/github-connector.js']) {
      assert.ok(recordsContentHash(rel), `${rel} records no content hash`);
      assert.ok(PINNED.has(rel), `${rel} is not classified as pinned`);
      assert.ok(!Object.prototype.hasOwnProperty.call(NOT_PINNED, rel),
        `${rel} is both pinned and excused; it must be one or the other`);
    }

    const repoMemory = sourceOf('plugins/repo-memory.js');
    assert.match(repoMemory, /pinnedRepoFile/,
      'repo-memory does not build a pinned reference for the files it was handed');
    assert.ok(!/resolveCommitSha|git\/trees|raw\.githubusercontent/.test(repoMemory),
      'repo-memory grew its own fetch path; it was meant to record what it already had');

    const connector = sourceOf('lib/github-connector.js');
    assert.match(connector, /sourceVersionKind/,
      'the connector does not record which kind of version it was given');
    assert.ok(!/fetch\(|api\.github\.com/.test(connector),
      'the connector grew a fetch path; it normalises items it is handed');
  });

  test('every unpinned path states why, and open gaps say so in those words', () => {
    for (const [rel, reason] of Object.entries(NOT_PINNED)) {
      assert.ok(reason && reason.length > 40, `${rel} has no real reason recorded`);
    }
    // The two classes must stay distinguishable: "nothing to pin" is finished
    // work, "OPEN GAP" is not, and collapsing them is how the second becomes
    // invisible.
    // No OPEN GAP entries remain. The distinction still has to hold if one is
    // added later, so it is asserted rather than deleted along with the entries.
    const openGaps = Object.entries(NOT_PINNED).filter(([, reason]) => /OPEN GAP/.test(reason));
    assert.deepStrictEqual(openGaps.map(([rel]) => rel), [],
      'an open gap is recorded here; it belongs in a tracked issue as well');
    assert.ok(!/OPEN GAP/.test(NOT_PINNED['lib/conflict-detector.js']));
  });
});
