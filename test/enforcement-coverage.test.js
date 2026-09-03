'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  sitesIn,
  bindingsFor,
  buildCoverageManifest,
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
