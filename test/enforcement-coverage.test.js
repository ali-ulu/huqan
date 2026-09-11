'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  sitesIn,
  bindingsFor,
  buildCoverageManifest,
  collectSites,
  productionFiles,
  staleClassifications,
  CAPABILITIES,
} = require('../scripts/enforcement-coverage');
const { ROLES, CLASSIFIED } = require('../scripts/enforcement-coverage-classification');

// ─── the invariant ───────────────────────────────────────────────────────────

test('every call site that can act on the world has a recorded role', () => {
  const manifest = buildCoverageManifest();
  const report = manifest.unclassified
    .map((entry) => `  ${entry.file} (${entry.capabilities.join(', ')})`)
    .join('\n');
  assert.deepEqual(manifest.unclassified, [],
    'these files can execute a process, write to disk or leave the machine, and nobody '
    + 'has recorded why:\n' + report);
});

test('every recorded role is one of the declared roles, with a real reason', () => {
  // A generic reason ("internal") would pass review forever without anyone
  // re-reading the code, so the reason has to be long enough to say something.
  for (const [file, classification] of Object.entries(CLASSIFIED)) {
    assert.ok(Object.hasOwn(ROLES, classification.role), `${file}: unknown role ${classification.role}`);
    assert.equal(typeof classification.why, 'string', file);
    assert.ok(classification.why.length > 30, `${file}: needs a reason, not a label`);
  }
});

test('no file is classified that no longer holds such a call site', () => {
  // A stale entry is how a list stops describing the code. If a file drops its
  // last risky call, its justification should go with it.
  const manifest = buildCoverageManifest();
  const withSites = new Set(manifest.entries.map((entry) => entry.file));
  const stale = Object.keys(CLASSIFIED).filter((file) => !withSites.has(file));
  assert.deepEqual(stale, [], 'these classifications no longer describe any call site');
});

// ─── the scan itself ─────────────────────────────────────────────────────────
//
// The manifest is only worth what its scan is worth. A version that silently
// found nothing would report a clean, complete, entirely fictional coverage.

test('the surface is substantial, so an empty result would not read as a pass', () => {
  const manifest = buildCoverageManifest();
  assert.ok(manifest.totals.sites > 50, `only ${manifest.totals.sites} sites found`);
  for (const capability of ['process', 'fs_write', 'egress']) {
    assert.ok(manifest.totals.byCapability[capability] > 0, `${capability} found nothing`);
  }
});

test('the known process-execution sites are all present', () => {
  // Named explicitly: if the scan regresses, this says which site it lost.
  const manifest = buildCoverageManifest();
  const processFiles = new Set(
    manifest.entries.filter((e) => e.capabilities.includes('process')).map((e) => e.file),
  );
  for (const file of [
    'sandboxRunner.js',
    'rustGraph.js',
    'backupRestore.js',
    'adapters/git-log-adapter.js',
    'lib/external-action-gate-install.js',
  ]) {
    assert.ok(processFiles.has(file), `${file} should hold a process call site`);
  }
});

test('a call through a bound namespace is found', () => {
  const source = "const cp = require('node:child_process');\ncp.spawnSync('x');\n";
  const found = sitesIn('probe.js', source);
  assert.equal(found.length, 1);
  assert.equal(found[0].capability, 'process');
  assert.equal(found[0].line, 2);
});

test('a destructured import is found under its local name', () => {
  const source = "const { spawnSync: run } = require('child_process');\nrun('x');\n";
  const found = sitesIn('probe.js', source);
  assert.equal(found.length, 1);
  assert.equal(found[0].call, 'run');
});

test('a same-named method on something else is not a finding', () => {
  // The reason this scanner resolves bindings at all. `db.exec(...)` appears in
  // five schema files and `regex.exec()` in two more; a naive scan for `exec(`
  // would report SQLite DDL as unaudited process execution and bury the ten
  // real sites in noise.
  const sqlite = "const db = openDatabase();\ndb.exec('CREATE TABLE t (id TEXT)');\n";
  assert.deepEqual(sitesIn('probe.js', sqlite), []);

  const regex = "const pattern = /x/g;\npattern.exec('xx');\n";
  assert.deepEqual(sitesIn('probe.js', regex), []);
});

test('a call named in a comment or a string is not a call', () => {
  const source = [
    "const cp = require('node:child_process');",
    "// cp.spawnSync('commented out')",
    "const doc = 'cp.spawnSync(fake)';",
    '/* cp.execSync(also) */',
  ].join('\n');
  assert.deepEqual(sitesIn('probe.js', source), []);
});

test('blanking strings does not hide the require that declares the binding', () => {
  // The bug the first version of this scanner shipped with: call sites were
  // matched on text with strings blanked, and bindings were resolved from the
  // same text -- so `require('node:fs')` became `require(          )` and the
  // scan reported three sites in a tree that has eighty.
  const source = "const fs = require('node:fs');\nfs.writeFileSync('a', 'b');\n";
  const found = sitesIn('probe.js', source);
  assert.equal(found.length, 1, 'the binding must be resolved from text with strings intact');
  assert.equal(found[0].capability, 'fs_write');
});

test('a module nobody imported produces nothing', () => {
  const source = "const value = { spawnSync: () => {} };\nvalue.spawnSync();\n";
  assert.deepEqual(sitesIn('probe.js', source), []);
});

test('bindings are resolved per capability, not globally', () => {
  const source = "const fs = require('node:fs');\nconst cp = require('node:child_process');\ncp.spawn('x');\nfs.rmSync('y');\n";
  const found = sitesIn('probe.js', source);
  assert.deepEqual(found.map((f) => f.capability).sort(), ['fs_write', 'process']);
});

test('a read-only fs call is deliberately out of scope', () => {
  // Reading is not a mutation, and gating it would drown the real surface.
  const source = "const fs = require('node:fs');\nfs.readFileSync('a');\nfs.existsSync('b');\n";
  assert.deepEqual(sitesIn('probe.js', source), []);
  assert.ok(!CAPABILITIES.fs_write.members.includes('readFileSync'));
});

// ─── indirection: an injected handle is still the capability ─────────────────
//
// Dependency injection is a normal pattern for testability -- it is how a test
// forces a write failure. A scan keyed only on the imported module identifier
// therefore had its blind spot lining up exactly with well-tested code. These
// pin the fix: an alias whose right-hand side is a binding the file resolved is
// followed, and a read-only handle stays out.

test('a local alias of a bound namespace is followed', () => {
  const source = "const fs = require('node:fs');\nconst store = fs;\nstore.writeFileSync('a', 'b');\n";
  const found = sitesIn('probe.js', source);
  assert.equal(found.length, 1);
  assert.equal(found[0].capability, 'fs_write');
  assert.equal(found[0].call, 'store.writeFileSync');
});

test('a local alias of a destructured member is followed', () => {
  const source = "const cp = require('node:child_process');\nconst run = cp.spawnSync;\nrun('x');\n";
  const found = sitesIn('probe.js', source);
  assert.equal(found.length, 1);
  assert.equal(found[0].capability, 'process');
  assert.equal(found[0].call, 'run');
});

test('a function parameter default that names a binding is followed', () => {
  // The shape lib/runtime-watchdog.js uses: `spawnProcess = spawn`.
  const source = [
    "const { spawn } = require('node:child_process');",
    'function start({ spawnProcess = spawn } = {}) {',
    "  spawnProcess('x');",
    '}',
  ].join('\n');
  const found = sitesIn('probe.js', source);
  assert.equal(found.length, 1);
  assert.equal(found[0].capability, 'process');
});

test('a destructuring default that names a binding is followed', () => {
  // The shape lib/coder/apply-derivation.js uses:
  // `const { ..., fs = nodeFs, ... } = options;`.
  const declared = "const nodeFs = require('node:fs');\nconst { fs = nodeFs } = options;\nfs.rmSync('x');\n";
  const found = sitesIn('probe.js', declared);
  assert.equal(found.length, 1);
  assert.equal(found[0].capability, 'fs_write');

  // And the assignment form: `({ fileSystem = fs } = opts)`.
  const assigned = "const fs = require('node:fs');\n({ fileSystem = fs } = opts);\nfileSystem.mkdirSync('d');\n";
  const viaAssignment = sitesIn('probe.js', assigned);
  assert.equal(viaAssignment.length, 1);
  assert.equal(viaAssignment[0].call, 'fileSystem.mkdirSync');
});

test('an injected handle used only for reads adds no site', () => {
  // The precision the alias rule must not cost: lib/coder/verify-derivation.js
  // and lib/mutation-journal.js both inject fs and only ever read through it.
  // Following the alias must not turn those into writes.
  const verify = "const nodeFs = require('node:fs');\nfunction directoryReader(root, fs = nodeFs) {\n  return fs.readFileSync('a', 'utf8');\n}\n";
  assert.deepEqual(sitesIn('probe.js', verify), []);

  const journal = "const fs = require('node:fs');\nfunction readMutationJournal(p, fileSystem = fs) {\n  return fileSystem.existsSync(p) ? fileSystem.readFileSync(p, 'utf8') : null;\n}\n";
  assert.deepEqual(sitesIn('probe.js', journal), []);
});

test('dynamic property access and an unbound handle stay invisible', () => {
  // Honest limits, pinned rather than asserted away: the alias rule follows an
  // identifier, not an expression.
  assert.deepEqual(sitesIn('probe.js', "const fs = require('node:fs');\nfs[name]('a');\n"), []);
  assert.deepEqual(sitesIn('probe.js', 'function f(handle) {\n  handle.writeFileSync("a", "b");\n}\n'), []);
});

// ─── untracked files are enumerated ──────────────────────────────────────────
//
// `git ls-files '*.js'` reported a not-yet-staged file as *absent*, so a new
// file passed the check for the reason that the scan could not see it. These
// pin the enumeration against a real temporary repository.

function git(dir, args) {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
}

function fixtureRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-coverage-'));
  git(dir, ['init', '--quiet']);
  fs.mkdirSync(path.join(dir, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'ignored'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.gitignore'), 'ignored/\n');
  fs.writeFileSync(
    path.join(dir, 'ignored', 'hidden-writer.js'),
    "const fs = require('node:fs');\nfs.writeFileSync('a', 'b');\n",
  );
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('an untracked file is scanned, not invisible', () => {
  const { dir, cleanup } = fixtureRepo();
  try {
    fs.writeFileSync(
      path.join(dir, 'lib', 'untracked-writer.js'),
      "const fs = require('node:fs');\nfs.writeFileSync('a', 'b');\n",
    );

    // If the old enumeration ever sees this file, the test has stopped proving
    // anything about the blind spot it exists to close.
    assert.equal(git(dir, ['ls-files', '*.js']).trim(), '',
      'the pre-fix enumeration must see nothing here');

    assert.ok(productionFiles(dir).includes('lib/untracked-writer.js'),
      'an untracked production file must be enumerated');

    const sites = collectSites(dir).filter((site) => site.file === 'lib/untracked-writer.js');
    assert.equal(sites.length, 1);

    const manifest = buildCoverageManifest(dir);
    assert.deepEqual(manifest.unclassified.map((entry) => entry.file), ['lib/untracked-writer.js'],
      'an untracked risky file must fail the invariant, not be absent from it');
  } finally {
    cleanup();
  }
});

test('untracked enumeration respects .gitignore and still sees staged files', () => {
  const { dir, cleanup } = fixtureRepo();
  try {
    fs.writeFileSync(
      path.join(dir, 'lib', 'staged-writer.js'),
      "const fs = require('node:fs');\nfs.writeFileSync('a', 'b');\n",
    );
    git(dir, ['add', 'lib/staged-writer.js']);

    assert.ok(productionFiles(dir).includes('lib/staged-writer.js'), 'a staged file is tracked');
    assert.ok(!productionFiles(dir).includes('ignored/hidden-writer.js'),
      'a .gitignore match must stay out of the scan');
  } finally {
    cleanup();
  }
});

test('a classification whose call site is gone is a failure', () => {
  // The companion invariant main() now evaluates. A list whose entries outlive
  // the call sites they justify is how the list stops describing the code.
  assert.deepEqual(staleClassifications({ entries: [] }), Object.keys(CLASSIFIED));
  assert.deepEqual(staleClassifications(buildCoverageManifest()), []);
});

// ─── the published artifact ──────────────────────────────────────────────────

test('the manifest states its own limits', () => {
  // A reader who only ever sees coverage-manifest.json must not take it for a
  // proof of enforcement. That disclaimer rides in the artifact, not only in
  // the source comment nobody downloads.
  const manifest = buildCoverageManifest();
  assert.match(manifest.establishes, /does NOT establish/);
  assert.match(manifest.establishes, /enforced at run time/);
  assert.equal(manifest.schemaVersion, 'huqan.enforcement-coverage.v1');
});

test('the unguarded surface is listed, not hidden', () => {
  // The point of publishing this at all. A governance product that conceals
  // its own gaps is making the error it exists to prevent.
  const manifest = buildCoverageManifest();
  assert.ok(manifest.unguarded.length > 0,
    'if this is ever empty, verify it rather than celebrating it');
  for (const entry of manifest.unguarded) {
    assert.equal(entry.role, 'unguarded');
    assert.ok(entry.why.length > 30, `${entry.file} needs a reason`);
  }
});

test('the checked-in manifest matches what the scan produces now', () => {
  // Otherwise the published artifact drifts from the tree it describes, which
  // is the same class of failure as documentation drift -- and here it would be
  // a false claim about the product's own enforcement surface.
  const onDisk = path.resolve(__dirname, '..', 'coverage-manifest.json');
  assert.ok(fs.existsSync(onDisk), 'coverage-manifest.json must be committed; run npm run check:enforcement-coverage');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(onDisk, 'utf8')),
    buildCoverageManifest(),
    'coverage-manifest.json is stale; re-run npm run check:enforcement-coverage and commit it',
  );
});
