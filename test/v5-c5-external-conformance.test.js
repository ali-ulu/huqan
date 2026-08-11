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

test.describe('V5-C5: the consumer only sees the published package', () => {
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
      `relative requires would resolve against the sandbox: ${relative.join(', ')}`);
  });

  test('every filesystem root it reads is derived from the resolved package root', () => {
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
    assert.match(runnerSource, /'install',\s*tarball,\s*'--ignore-scripts'/);
  });
});

test.describe('V5-C5: evidence claims are group-scoped', () => {
  test('the consumer names all evidence levels explicitly', () => {
    for (const level of [
      'packaged-surface-smoke',
      'self-test',
      'cross-implementation-conformance',
    ]) {
      assert.match(consumerSource, new RegExp(level));
    }
  });

  test('there is no single global packaged-surface-conformance level', () => {
    assert.ok(!/evidenceLevel:\s*['"]packaged-surface-conformance['"]/.test(consumerSource));
    assert.ok(!/Level 2 of four/.test(consumerSource));
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

  test('the report carries group levels and the disclaimer', () => {
    assert.match(consumerSource, /evidenceLevels:/);
    assert.match(consumerSource, /Evidence is group-scoped/);
    assert.match(consumerSource, /does not establish third-party verification or interoperability/);
  });
});

test.describe('V5-C5: external conformance run', { concurrency: 1 }, () => {
  let report = null;
  let project = null;

  test('the runner completes with no failing case', () => {
    const result = cp.spawnSync(process.execPath, [RUNNER, '--json', '--keep'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: 900000,
    });

    assert.ok(result.stdout,
      `runner produced no report. stderr: ${(result.stderr || '').slice(0, 1000)}`);
    report = JSON.parse(result.stdout);
    project = report.consumerProject;

    assert.equal(result.status, 0,
      `runner exited ${result.status}. failing cases: ${JSON.stringify(
        report.cases.filter((c) => c.status === 'fail'), null, 2)}`);
    assert.equal(report.failed, 0);
    assert.ok(report.total >= 45, `expected at least 45 cases, got ${report.total}`);
    assert.equal(report.passed + report.skipped + report.failed, report.total);
    assert.equal(report.skipped, 0, 'Certified Node criteria reject skipped cases');
    assert.equal(report.passed, report.total, 'Certified Node criteria require every case to pass');
    assert.equal(report.cases.length, report.total, 'case inventory must match the reported total');
    assert.ok(report.cases.every((item) => item.status === 'pass'),
      'Certified Node criteria require every reported case to pass');
    assert.deepStrictEqual(report.evidenceLevels, {
      surface: 'packaged-surface-smoke',
      objects: 'self-test',
      'fail-closed': 'self-test',
      bundles: 'self-test',
      'package-wire': 'installed-package-self-test',
      replay: 'self-test',
      v5: 'self-test',
      'cross-implementation': 'cross-implementation-conformance',
    });
    const crossImplementationCases = report.cases.filter(
      (item) => item.group === 'cross-implementation',
    );
    assert.equal(crossImplementationCases.length, 1,
      'exactly one cross-implementation case is required');
    const [crossImplementationCase] = crossImplementationCases;
    assert.equal(crossImplementationCase.name,
      'the shipped Python verifier reports the same findings');
    assert.equal(crossImplementationCase.status, 'pass');
    assert.equal(crossImplementationCase.evidenceLevel, 'cross-implementation-conformance');
    assert.equal(report.crossImplementationExecuted, true,
      'installed Python must execute the cross-implementation comparison');
  });

  test('malformed bundle envelopes are exercised and fail closed', () => {
    assert.ok(report, 'previous test did not produce a report');
    for (const expectedName of [
      'bundle missing receipts fails closed before hash checks',
      'bundle with non-array receipts fails closed',
      'bundle missing another required envelope field fails closed',
    ]) {
      const item = report.cases.find((c) => c.name === expectedName);
      assert.ok(item, `missing structural negative case: ${expectedName}`);
      assert.equal(item.status, 'pass', `${expectedName}: ${item && item.detail}`);
      assert.equal(item.evidenceLevel, 'self-test');
    }
  });

  test('real V5 cases replace every blocked gap and fail closed mechanically', () => {
    assert.ok(report, 'previous test did not produce a report');
    assert.deepStrictEqual(report.blockedGaps, []);
    for (const fragment of [
      'Shared Trust Package schema accepts',
      'C3 and C4 schemas remain distinct',
      'C3 scope absence',
      'C3 evidence absence',
      'C3 expiry absence',
    ]) {
      const item = report.cases.find((candidate) => candidate.name.includes(fragment));
      assert.ok(item, `missing real V5 case: ${fragment}`);
      assert.equal(item.status, 'pass', `${item.name}: ${item.detail}`);
      assert.equal(item.evidenceLevel, 'self-test');
    }
  });

  test('the installed authority rejects an identical signed package replay', () => {
    assert.ok(report, 'previous test did not produce a report');
    const item = report.cases.find((candidate) => candidate.name
      === 'installed authority accepts once and rejects the identical signed package replay');
    assert.ok(item, 'missing installed-package replay case');
    assert.equal(item.status, 'pass', item.detail);
    assert.equal(item.evidenceLevel, 'self-test');
  });

  test('the replay case fails if duplicate reservation is bypassed', () => {
    assert.ok(project && fs.existsSync(project), 'kept consumer project is missing');
    const source = fs.readFileSync(path.join(project, 'consumer.js'), 'utf8');
    const mutated = source.replace(
      'if (seen.has(record.replayKey)) return { reserved: false, existing:',
      'if (false && seen.has(record.replayKey)) return { reserved: false, existing:',
    );
    assert.notEqual(mutated, source, 'replay-store mutation did not apply');
    const mutantPath = path.join(project, 'consumer.replay-mutant.js');
    fs.writeFileSync(mutantPath, mutated);
    const result = cp.spawnSync(process.execPath, [mutantPath], {
      cwd: project,
      encoding: 'utf8',
      timeout: 300000,
    });
    assert.equal(result.status, 1, 'replay bypass mutant passed');
    const mutantReport = JSON.parse(result.stdout);
    const failures = mutantReport.cases.filter((candidate) => candidate.status === 'fail');
    assert.equal(failures.length, 1, `unexpected mutant failures: ${JSON.stringify(failures)}`);
    assert.match(failures[0].name, /identical signed package replay/);
  });

  test('the consumer fails when an expectation no longer holds', () => {
    assert.ok(project && fs.existsSync(project), 'kept consumer project is missing');

    const source = fs.readFileSync(path.join(project, 'consumer.js'), 'utf8');
    const mutated = source.replace(
      "'receipt-bundle.valid.json': [],",
      "'receipt-bundle.valid.json': ['bundle_seal_mismatch'],",
    );
    assert.notEqual(mutated, source, 'mutation did not apply; the expectation table moved');

    const mutantPath = path.join(project, 'consumer.mutant.js');
    fs.writeFileSync(mutantPath, mutated);
    const result = cp.spawnSync(process.execPath, [mutantPath], {
      cwd: project,
      encoding: 'utf8',
      timeout: 300000,
    });

    assert.equal(result.status, 1,
      'mutated consumer passed; the runner cannot detect a wrong expectation');
    const mutantReport = JSON.parse(result.stdout);
    const failures = mutantReport.cases.filter((c) => c.status === 'fail');
    assert.equal(failures.length, 1, `expected one failure, got ${JSON.stringify(failures)}`);
    assert.match(failures[0].name, /receipt-bundle\.valid\.json/);
  });

  test('python unavailable is a skip, never a pass', () => {
    assert.ok(project && fs.existsSync(project), 'kept consumer project is missing');

    const source = fs.readFileSync(path.join(project, 'consumer.js'), 'utf8');
    const mutated = source.replace('function findPython() {',
      'function findPython() { return null;');
    assert.notEqual(mutated, source, 'python probe mutation did not apply');

    const mutantPath = path.join(project, 'consumer.no-python.js');
    fs.writeFileSync(mutantPath, mutated);
    const result = cp.spawnSync(process.execPath, [mutantPath], {
      cwd: project,
      encoding: 'utf8',
      timeout: 300000,
    });

    assert.equal(result.status, 0, 'python absence should skip only that comparison');
    const mutantReport = JSON.parse(result.stdout);
    const pythonCase = mutantReport.cases.find(
      (c) => c.name === 'the shipped Python verifier reports the same findings',
    );
    assert.ok(pythonCase, 'python comparison case missing');
    assert.equal(pythonCase.status, 'skip');
    assert.equal(pythonCase.evidenceLevel, 'cross-implementation-conformance');
    assert.equal(mutantReport.crossImplementationExecuted, false);
    assert.match(mutantReport.evidenceLevelNote,
      /cross-implementation conformance only when its case passes/);
    assert.equal(mutantReport.skipped, 1);
    assert.equal(mutantReport.failed, 0);
    assert.equal(mutantReport.passed, mutantReport.total - 1);
  });

  test('a non-Python-3 candidate is rejected, never cross-implementation evidence', () => {
    assert.ok(project && fs.existsSync(project), 'kept consumer project is missing');

    const source = fs.readFileSync(path.join(project, 'consumer.js'), 'utf8');
    const candidateStart = "const candidates = process.platform === 'win32'";
    const candidateEnd = ": [{ command: 'python3', args: [] }, { command: 'python', args: [] }];";
    const start = source.indexOf(candidateStart);
    const end = source.indexOf(candidateEnd, start);
    assert.ok(start >= 0 && end >= 0, 'Python candidate table moved');
    const simulatedNon3 = `const candidates = [{ command: ${JSON.stringify(process.execPath)}, args: [
      '-e', 'process.exit(process.argv.some((arg) => arg.includes("sys.version_info")) ? 1 : 0)',
    ] }];`;
    const mutated = source.slice(0, start) + simulatedNon3
      + source.slice(end + candidateEnd.length);

    const mutantPath = path.join(project, 'consumer.non-python-3.js');
    fs.writeFileSync(mutantPath, mutated);
    const result = cp.spawnSync(process.execPath, [mutantPath], {
      cwd: project,
      encoding: 'utf8',
      timeout: 300000,
    });

    assert.equal(result.status, 0, 'non-Python-3 candidate should skip only that comparison');
    const mutantReport = JSON.parse(result.stdout);
    const pythonCase = mutantReport.cases.find(
      (c) => c.name === 'the shipped Python verifier reports the same findings',
    );
    assert.ok(pythonCase, 'python comparison case missing');
    assert.equal(pythonCase.status, 'skip');
    assert.equal(mutantReport.crossImplementationExecuted, false);
    assert.equal(mutantReport.skipped, 1);
  });

  test.after(() => {
    if (project) {
      try {
        fs.rmSync(path.dirname(project), { recursive: true, force: true });
      } catch (_) { /* best effort */ }
    }
  });
});

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
