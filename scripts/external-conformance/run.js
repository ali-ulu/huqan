#!/usr/bin/env node
'use strict';

/**
 * V5-C5 external conformance runner.
 *
 *   npm run conformance:external
 *
 * Builds the publishable tarball with `npm pack`, installs it into a throwaway
 * project outside this repository, copies consumer.js in, and runs it there.
 * The consumer sees the package and nothing else: no working tree, no `test/`,
 * no `schemas/`, no dev dependencies.
 *
 * Read scripts/external-conformance/consumer.js for what is actually checked
 * and for the limits of what a passing run establishes. In short: it shows the
 * published artifact is self-sufficient for ATP v0.1 trust objects. It is not
 * third-party verification, because the same authors wrote both sides.
 *
 * Flags:
 *   --keep    leave the sandbox on disk and print its path
 *   --json    print only the consumer's JSON report
 *
 * Exit status is the consumer's: 0 when every case passes, 1 otherwise.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const KEEP = process.argv.includes('--keep');
const JSON_ONLY = process.argv.includes('--json');

function log(...args) {
  if (!JSON_ONLY) console.log(...args);
}

function fail(message, detail) {
  console.error(`external conformance runner: ${message}`);
  if (detail) console.error(String(detail).slice(0, 2000));
  process.exit(2);
}

function npm(args, cwd) {
  return spawnSync('npm', args, {
    cwd,
    encoding: 'utf8',
    timeout: 600000,
    shell: true,
    env: { ...process.env, NO_COLOR: '1' },
  });
}

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-external-conformance-'));

// The sandbox must not sit inside the repository: a consumer that can walk up
// into the working tree is not external in any useful sense.
if (!path.relative(REPO_ROOT, sandbox).startsWith('..')) {
  fail(`sandbox ${sandbox} is inside the repository; refusing to run`);
}

function cleanup() {
  if (KEEP) {
    log(`\nsandbox kept at ${sandbox}`);
    return;
  }
  try {
    fs.rmSync(sandbox, { recursive: true, force: true });
  } catch (_) { /* best effort */ }
}

try {
  log('1/4  npm pack');
  const packed = npm(['pack', '--json', '--ignore-scripts', `--pack-destination=${sandbox}`], REPO_ROOT);
  if (packed.status !== 0) fail('npm pack failed', packed.stderr || packed.stdout);

  const tarballs = fs.readdirSync(sandbox).filter((f) => f.endsWith('.tgz'));
  if (tarballs.length !== 1) fail(`expected exactly one tarball, found ${tarballs.length}`);
  const tarball = path.join(sandbox, tarballs[0]);
  log(`     ${tarballs[0]} (${(fs.statSync(tarball).size / 1024).toFixed(0)} KiB)`);

  log('2/4  create consumer project');
  const project = path.join(sandbox, 'consumer');
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, 'package.json'), `${JSON.stringify({
    name: 'huqan-external-consumer',
    version: '0.0.0',
    private: true,
    description: 'Throwaway consumer that has only the published huqan tarball.',
  }, null, 2)}\n`);

  log('3/4  npm install the tarball');
  // --ignore-scripts matters: huqan depends on better-sqlite3, which builds
  // native code. The consumer never loads it, and requiring a toolchain here
  // would make the runner test the environment instead of the package.
  const installed = npm(['install', tarball, '--ignore-scripts', '--no-audit', '--no-fund'], project);
  if (installed.status !== 0) {
    fail('npm install of the packed tarball failed', installed.stderr || installed.stdout);
  }

  log('4/4  run consumer');
  fs.copyFileSync(path.join(__dirname, 'consumer.js'), path.join(project, 'consumer.js'));
  const run = spawnSync(process.execPath, ['consumer.js'], {
    cwd: project,
    encoding: 'utf8',
    timeout: 300000,
  });

  if (run.error) fail('consumer failed to start', run.error.message);
  if (run.stderr) process.stderr.write(run.stderr);
  if (!run.stdout) fail('consumer produced no report');

  let report;
  try {
    report = JSON.parse(run.stdout);
  } catch (error) {
    fail('consumer report is not JSON', run.stdout);
  }

  if (JSON_ONLY) {
    // consumerProject is only meaningful with --keep, and callers that want to
    // re-run the consumer against the same install need it in machine form.
    process.stdout.write(`${JSON.stringify({ ...report, consumerProject: KEEP ? project : null }, null, 2)}\n`);
  } else {
    console.log('');
    for (const item of report.cases) {
      const mark = item.ok ? 'ok  ' : 'FAIL';
      console.log(`${mark} [${item.group}] ${item.name}${item.detail ? `  -- ${item.detail}` : ''}`);
    }
    console.log('');
    console.log(`evidence level : ${report.evidenceLevel}`);
    console.log(`package        : huqan@${report.packageVersion}`);
    console.log(`cases          : ${report.passed}/${report.total} passed, ${report.failed} failed`);
    console.log(`blocked gaps   : ${report.blockedGaps.length}`);
    for (const gap of report.blockedGaps) {
      console.log(`  - ${gap.criterion} (needs ${gap.absent})`);
    }
    console.log('');
    console.log(report.evidenceLevelNote);
  }

  cleanup();
  process.exit(run.status === 0 ? 0 : 1);
} catch (error) {
  cleanup();
  fail('unexpected failure', error && error.stack);
}
