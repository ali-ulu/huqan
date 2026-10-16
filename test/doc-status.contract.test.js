'use strict';

/**
 * #295: the V5 document set has to say what each of its documents is.
 *
 * The risk this guards is quiet rather than loud. A planning document written
 * in the present tense reads like a description of the product, and this
 * directory holds shipped work, authorized specifications, contracts, task
 * orders, research, and directions nobody has authorized -- side by side, in
 * the same voice. Fourteen of sixty-one carried a `## Status` prose section,
 * under four different spellings; forty-seven carried nothing.
 *
 * Prose is what a reader needs and is not what a check can hold, so each
 * document also declares one machine-readable status. This test is what makes
 * the declaration load-bearing: without it the labels are decoration that the
 * next document is free to skip.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  DOC_ROOT,
  EXEMPT,
  MUST_PIN_A_COMMIT,
  STATUS_VOCABULARY,
  checkDocStatus,
  listDocs,
  readDeclaration,
  report,
} = require('../scripts/check-doc-status');

const repoRoot = path.resolve(__dirname, '..');

test('every V5 document declares a status from the vocabulary (#295)', () => {
  const result = checkDocStatus();

  assert.deepEqual(result.missing, [], report(result));
  assert.deepEqual(result.invalid, [], report(result));
});

test('the vocabulary is not trivially satisfied by one bucket (#295)', () => {
  const { counts } = checkDocStatus();

  // A classification everything falls into classifies nothing. The set really
  // does span shipped work, specifications and unauthorized directions, and
  // the labels have to reflect that rather than collapse.
  assert.ok(counts.size >= 4, `expected several statuses in use, saw ${[...counts.keys()].join(', ')}`);
  assert.ok(counts.get('spec') > 0);
  assert.ok(counts.get('closeout') > 0);
  assert.ok(counts.get('future') > 0, 'the unauthorized directions have to stay visible as such');
});

test('a document claiming an invented status fails rather than passing unread (#295)', (t) => {
  const scratch = path.join(repoRoot, DOC_ROOT, 'zz-doc-status-probe.md');
  t.after(() => fs.rmSync(scratch, { force: true }));

  fs.writeFileSync(scratch, '# Probe\n\n**Status:** `productionready`\n');
  const invented = checkDocStatus();
  assert.equal(invented.invalid.length, 1);
  assert.equal(invented.invalid[0].declared, 'productionready');

  // And a document with no declaration at all is caught too -- the case that
  // described forty-seven of these files before this landed.
  fs.writeFileSync(scratch, '# Probe\n\nNo status anywhere.\n');
  const silent = checkDocStatus();
  assert.equal(silent.missing.length, 1);
  assert.match(report(silent), /declare no status/);
});

test('a declaration buried below the fold does not count (#295)', (t) => {
  const scratch = path.join(repoRoot, DOC_ROOT, 'zz-doc-status-buried.md');
  t.after(() => fs.rmSync(scratch, { force: true }));

  // A label a reader has to scroll for is not a label. The window is part of
  // the contract, not an implementation detail of the scanner.
  fs.writeFileSync(scratch, `# Probe\n${'\nfiller'.repeat(30)}\n\n**Status:** \`spec\`\n`);
  assert.equal(readDeclaration(`${DOC_ROOT}/zz-doc-status-buried.md`), null);
  assert.equal(checkDocStatus().missing.length, 1);
});

test('every exemption states why it is exempt (#295)', () => {
  for (const [relPath, reason] of Object.entries(EXEMPT)) {
    assert.ok(fs.existsSync(path.join(repoRoot, relPath)), `${relPath} is exempted but does not exist`);
    assert.ok(reason && reason.length > 20, `${relPath} needs a reason, not a placeholder`);
  }
  // The exemption list is a set of decisions; it must not become a way to opt
  // documents out quietly.
  assert.ok(Object.keys(EXEMPT).length <= 3, 'exemptions should stay rare enough to read');
});

test('the README documents the vocabulary it enforces (#295)', () => {
  const readme = fs.readFileSync(path.join(repoRoot, DOC_ROOT, 'README.md'), 'utf8');

  for (const status of Object.keys(STATUS_VOCABULARY)) {
    assert.match(readme, new RegExp('`' + status + '`'), `${status} is enforced but undocumented`);
  }
  // Documented in the index, and the index is the file exempted from carrying
  // one -- so the two facts have to stay consistent.
  assert.ok(Object.hasOwn(EXEMPT, `${DOC_ROOT}/README.md`));
});

test('the scanned set is the directory itself, not a stale list (#295)', () => {
  const onDisk = fs.readdirSync(path.join(repoRoot, DOC_ROOT))
    .filter(name => name.endsWith('.md'))
    .length;

  assert.equal(listDocs().length, onDisk, 'the checker must read the directory, so a new file is seen');
});

// --- #700: a record about a version has to name the version ---

test('every closeout, implementation and contract record names a commit (#700)', () => {
  const result = checkDocStatus();

  assert.deepEqual(result.unpinned, [], report(result));
});

test('an unpinned record of a pinning class fails, and one of a free class does not (#700)', (t) => {
  const pinning = path.join(repoRoot, DOC_ROOT, 'zz-pin-probe.md');
  const free = path.join(repoRoot, DOC_ROOT, 'zz-free-probe.md');
  t.after(() => { fs.rmSync(pinning, { force: true }); fs.rmSync(free, { force: true }); });

  fs.writeFileSync(pinning, '# Probe\n\n**Status:** `closeout`\n\nMeasured something, somewhere.\n');
  const caught = checkDocStatus();
  assert.equal(caught.unpinned.length, 1);
  assert.equal(caught.unpinned[0].declared, 'closeout');
  assert.match(report(caught), /do not say what they are about/);
  assert.match(report(caught), /a guessed commit makes an unverifiable/);
  fs.rmSync(pinning);

  // A direction nobody authorized has nothing to pin, and the rule must not
  // pretend otherwise -- that is how a plausible-looking SHA gets invented.
  fs.writeFileSync(free, '# Probe\n\n**Status:** `future`\n\nSomeday, perhaps.\n');
  assert.deepEqual(checkDocStatus().unpinned, []);
});

test('the pinning classes are the ones whose claim is about a version (#700)', () => {
  assert.deepEqual([...MUST_PIN_A_COMMIT].sort(), ['closeout', 'contract', 'implementation']);

  // Stated as an intention rather than left implicit: four `spec` documents
  // legitimately carry no commit, because a scope definition is routinely
  // written before the work it scopes exists.
  for (const free of ['spec', 'future', 'draft', 'research', 'archive']) {
    assert.equal(MUST_PIN_A_COMMIT.includes(free), false, `${free} must not be forced to pin`);
  }
});
