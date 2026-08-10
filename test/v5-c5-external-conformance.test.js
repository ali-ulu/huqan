'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const RUNNER_DIR = path.join(REPO_ROOT, 'scripts', 'external-conformance');
const RUNNER = path.join(RUNNER_DIR, 'run.js');
const CONSUMER = path.join(RUNNER_DIR, 'consumer.js');

const consumerSource = fs.readFileSync(CONSUMER, 'utf8');
const runnerSource = fs.readFileSync(RUNNER, 'utf8');

// ===========================================================================
// The consumer must be external. These are structural checks over its source:
// a consumer that reaches into the repository is testing the working tree, not
// the published package, and would pass for the wrong reason.
// ===========================================================================

test.describe('V5-C5: the consumer only sees the published package', () => {
  /** Every module specifier the consumer requires, in source order. */
  function requiredSpecifiers(source) {
    const specifiers = [];
    const pattern = /require\(\s*(['"])([^'"]+)\1\s*\)/g;
    let match = pattern.exec(source);
    while (match) {
      specifiers.push(match[2]);
      match = pattern.exec(source);
    }
    return specifiers;
  }

  test('it requires only node builtins and the installed huqan package', () => {
    const offending = requiredSpecifiers(consumerSource).filter((spec) => (
      !spec.startsWith('node:') && spec !== 'huqan' && !spec.startsWith('huqan/')
    ));
    assert.deepStrictEqual(offending, [],
      `consumer must not require anything outside node: and huqan: ${offending.join(', ')}`);
  });

  test('it has no relative import that could escape into the repository', () => {
    const relative = requiredSpecifiers(consumerSource).filter((spec) => spec.startsWith('.'));
    assert.deepStrictEqual(relative, [],
      `relative requires would resolve against the sandbox, not the package: ${relative.join(', ')}`);
  });

  test('every filesystem root it reads is derived from the resolved package root', () => {
    // PKG_ROOT is the only permitted anchor. If a second anchor appears -- a
    // literal repo path, process.cwd(), __dirname joined to '..' -- the
    // consumer is no longer confined to the installed package.
    assert.match(consumerSource,
      /const PKG_ROOT = path\.dirname\(require\.resolve\('huqan\/package\.json'\)\)/);
    assert.ok(!/process\.cwd\(\)/.test(consumerSource),
      'consumer must not anchor paths at the working directory');
    assert.ok(!/__dirname/.test(consumerSource),
      'consumer must not anchor paths at its own location');
  });

  test('the runner refuses a sandbox inside the repository', () => {
    assert.match(runnerSource, /path\.relative\(REPO_ROOT, sandbox\)\.startsWith\('\.\.'\)/);
    assert.match(runnerSource, /refusing to run/);
  });

  test('the runner installs with --ignore-scripts', () => {
    // huqan depends on better-sqlite3, which compiles native code on install.
    // Without this the runner would be testing the build toolchain.
    assert.match(runnerSource, /'install',\s*tarball,\s*'--ignore-scripts'/);
  });
});

// ===========================================================================
// Claim discipline. The runner establishes packaged-surface conformance and
// must not be readable as more than that -- the same overclaim V5-C5A removed
// from the bundle specification.
// ===========================================================================

test.describe('V5-C5: the runner states its evidence level and claims no more', () => {
  test('the consumer names the level explicitly', () => {
    assert.match(consumerSource, /packaged-surface-conformance/);
    assert.match(consumerSource, /not third-party verification/i);
  });

  test('neither file claims third-party verification or interoperability', () => {
    for (const [name, source] of [['consumer', consumerSource], ['runner', runnerSource]]) {
      for (const claim of [
        /\bthird[- ]party verified\b/i,
        /\bindependently verified\b/i,
        /\binteroperab(le|ility) (proven|established|verified)\b/i,
      ]) {
        assert.ok(!claim.test(source), `${name} makes an unsupported claim matching ${claim}`);
      }
    }
  });

  test('the report carries the level and the disclaimer, not just the prose', () => {
    assert.match(consumerSource, /evidenceLevel:/);
    assert.match(consumerSource, /evidenceLevelNote:/);
  });
});

// ===========================================================================
// End-to-end. One pack + install, then two consumer runs: the real one, and a
// deliberately broken copy that must fail. A green runner that has never been
// shown red is not evidence that it can detect anything.
// ===========================================================================

test.describe('V5-C5: external conformance run', { concurrency: 1 }, () => {
  let report = null;
  let project = null;

  test('the runner completes and every case passes', () => {
    const result = cp.spawnSync(process.execPath, [RUNNER, '--json', '--keep'], {
      cwd: REPO_ROOT, encoding: 'utf8', timeout: 900000,
    });

    assert.ok(result.stdout, `runner produced no report. stderr: ${(result.stderr || '').slice(0, 1000)}`);
    report = JSON.parse(result.stdout);
    project = report.consumerProject;

    assert.equal(result.status, 0,
      `runner exited ${result.status}. failing cases: ${JSON.stringify(
        report.cases.filter((c) => !c.ok), null, 2)}`);
    assert.equal(report.failed, 0);
    assert.ok(report.total >= 40, `expected a substantial case count, got ${report.total}`);
    assert.equal(report.evidenceLevel, 'packaged-surface-conformance');
  });

  test('the report records the blocked gaps rather than omitting them', () => {
    assert.ok(report, 'previous test did not produce a report');
    const criteria = report.blockedGaps.map((g) => g.criterion);
    assert.ok(criteria.some((c) => /package validation/.test(c)), 'package validation gap missing');
    assert.ok(criteria.some((c) => /C3\/C4|HTP/.test(c)), 'V5 object compatibility gap missing');
    assert.ok(criteria.some((c) => /scope/.test(c)), 'scope/evidence/expiry gap missing');
    for (const gap of report.blockedGaps) {
      assert.ok(gap.absent && gap.reason, `gap ${gap.criterion} lacks absent/reason`);
    }
  });

  test('the consumer fails when an expectation no longer holds', () => {
    assert.ok(project && fs.existsSync(project), 'kept consumer project is missing');

    // One leaf change: claim the valid bundle should report a finding. Nothing
    // else differs, so a failure can only come from the check itself.
    const source = fs.readFileSync(path.join(project, 'consumer.js'), 'utf8');
    const mutated = source.replace(
      "'receipt-bundle.valid.json': [],",
      "'receipt-bundle.valid.json': ['bundle_seal_mismatch'],",
    );
    assert.notEqual(mutated, source, 'mutation did not apply; the expectation table moved');

    const mutantPath = path.join(project, 'consumer.mutant.js');
    fs.writeFileSync(mutantPath, mutated);
    const result = cp.spawnSync(process.execPath, [mutantPath], {
      cwd: project, encoding: 'utf8', timeout: 300000,
    });

    assert.equal(result.status, 1, 'mutated consumer passed; the runner cannot detect a wrong expectation');
    const mutantReport = JSON.parse(result.stdout);
    const failures = mutantReport.cases.filter((c) => !c.ok);
    assert.equal(failures.length, 1, `expected exactly one failure, got ${JSON.stringify(failures)}`);
    assert.match(failures[0].name, /receipt-bundle\.valid\.json/);
  });

  test.after(() => {
    if (project) {
      try { fs.rmSync(path.dirname(project), { recursive: true, force: true }); } catch (_) { /* best effort */ }
    }
  });
});

// ===========================================================================
// Wiring.
// ===========================================================================

test.describe('V5-C5: the runner is reachable as one command', () => {
  test('package.json exposes conformance:external', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    assert.equal(pkg.scripts['conformance:external'], 'node scripts/external-conformance/run.js');
  });

  test('the runner ships nothing: it is not in the files allowlist', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
    const shipped = pkg.files.filter((f) => f.startsWith('scripts/external-conformance/'));
    assert.deepStrictEqual(shipped, [],
      'the conformance runner is a development tool and must not enter the package');
  });

  test('scripts/ is a standalone prefix, so no reachability acknowledgement is owed', () => {
    const { STANDALONE_PREFIXES } = require('../lib/module-reachability');
    assert.ok(STANDALONE_PREFIXES.includes('scripts/'));
  });
});

