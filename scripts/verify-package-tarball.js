#!/usr/bin/env node
'use strict';

/**
 * Pack the package, install it into an empty project, and check that it works.
 *
 * This is the one pre-publish check that cannot be done by reading the source
 * tree. `npm test` and scripts/check-package-closure.js both run against a
 * clone, where every relative path resolves whether or not package.json#files
 * ships it. v0.10.0 shipped three modules that way -- present in the repo,
 * absent from the tarball, `Cannot find module` from inside node_modules.
 *
 * The failure mode this is built around is quiet. A plugin or adapter that
 * fails to load prints a line and the run still exits 0, so a check that only
 * looked at exit codes would have passed the broken tarball. Every assertion
 * here reads the output.
 *
 * Both supported install shapes are covered. `--omit=optional` is a documented
 * install (pdfjs-dist and pdfkit are optional), so it has to keep working: the
 * two PDF paths may go unavailable, nothing else may.
 *
 * Usage:  node scripts/verify-package-tarball.js
 * Exit 0 = the published tarball behaves, exit 1 = it does not.
 */

// #2230: tarball install orchestrator. This file keeps only this job: pack,
// install both supported shapes, run the verifiers, verdict. Primitives live
// in verify-tarball-shared.js, verifiers in verify-tarball-checks-core.js and
// verify-tarball-checks-guard.js.
//
// verify-published-round-trip.js (#2631) requires THIS module (not the parts)
// so its `require('./verify-package-tarball')` keeps working unchanged.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  NPM_COMMAND,
  fail,
  failures,
  ok,
  pkg,
  repoRoot,
  run,
} = require('./verify-tarball-shared');
const {
  verifyBinsAndVersion,
  verifyExternalAdapters,
  verifyQuickstart,
} = require('./verify-tarball-checks-core');
const {
  verifyA2aRuntime,
  verifyDecisionExplainer,
  verifyExternalGuard,
  verifyMcp,
} = require('./verify-tarball-checks-guard');

/**
 * @param {string} label human name for this install shape
 * @param {string} tarball absolute path to the packed tarball
 * @param {string[]} installFlags extra flags for `npm install`
 */
function verifyInstall(label, tarball, installFlags) {
  console.log(`\n── ${label} ${'─'.repeat(Math.max(0, 60 - label.length))}`);

  const consumer = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-tarball-'));
  // A home of its own: quickstart writes under HOME, and a verification run
  // must not touch the operator's real memory.
  const home = path.join(consumer, 'home');
  fs.mkdirSync(home);
  const env = { ...process.env, HOME: home, USERPROFILE: home };

  try {
    const init = run(NPM_COMMAND, ['init', '-y'], { cwd: consumer });
    if (init.status !== 0) {
      fail(`${label}: could not initialise the consumer project`);
      return;
    }

    const install = run(NPM_COMMAND, ['install', tarball, '--no-audit', '--no-fund', ...installFlags], {
      cwd: consumer,
      env,
    });
    if (install.status !== 0) {
      fail(`${label}: npm install failed\n${install.output.slice(-2000)}`);
      return;
    }
    ok(`installs (${installFlags.join(' ') || 'default'})`);

    const binDir = path.join(consumer, 'node_modules', '.bin');
    verifyBinsAndVersion(label, binDir, consumer, env);

    verifyExternalAdapters(label, consumer);
    verifyExternalGuard(label, binDir, consumer, env);
    verifyDecisionExplainer(label, consumer, env);

    verifyQuickstart(label, binDir, consumer, env);

    verifyMcp(label, binDir, consumer, env);
    verifyA2aRuntime(label, consumer, env);
  } finally {
    fs.rmSync(consumer, { recursive: true, force: true });
  }
}

function main() {
  console.log(`Verifying the ${pkg.name}@${pkg.version} tarball as an installed consumer sees it.`);

  const packDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-pack-'));
  try {
    const pack = run(NPM_COMMAND, ['pack', '--pack-destination', packDir], { cwd: repoRoot });
    if (pack.status !== 0) {
      fail(`npm pack failed\n${pack.output.slice(-2000)}`);
      return 1;
    }
    const tarballName = fs.readdirSync(packDir).find((name) => name.endsWith('.tgz'));
    if (!tarballName) {
      fail('npm pack produced no tarball');
      return 1;
    }
    const tarball = path.join(packDir, tarballName);
    console.log(`  packed: ${tarballName} (${(fs.statSync(tarball).size / 1024).toFixed(0)} KB)`);

    verifyInstall('full install', tarball, []);
    // Documented in README.md and docs/npm-publish.md, so it is a contract.
    verifyInstall('install with --omit=optional', tarball, ['--omit=optional']);
  } finally {
    fs.rmSync(packDir, { recursive: true, force: true });
  }

  console.log('');
  if (failures.length === 0) {
    console.log('OK: the packed tarball installs and runs in both supported shapes.');
    return 0;
  }
  console.error(`FAIL: ${failures.length} problem(s) with the packed tarball. `
    + 'Publishing this would ship them.');
  return 1;
}

if (require.main === module) process.exit(main());

module.exports = {
  ...require('./verify-tarball-shared'),
  ...require('./verify-tarball-checks-core'),
  ...require('./verify-tarball-checks-guard'),
};
