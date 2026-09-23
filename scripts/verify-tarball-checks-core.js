'use strict';

// #2230: installed-package verifiers (part 1) extracted from
// scripts/verify-package-tarball.js. One job: bins, quickstart, plugins and
// adapters of an already-installed consumer. No pack/install orchestration.

const fs = require('node:fs');
const path = require('node:path');
const {
  LOAD_FAILURE_PATTERNS,
  fail,
  ok,
  packageBin,
  pkg,
  run,
} = require('./verify-tarball-shared');

/**
 * Every declared bin is present in the install and reports the expected
 * version. Shared with scripts/verify-published-round-trip.js (#2631), which
 * checks the registry copy instead of a local pack.
 */
function verifyBinsAndVersion(label, binDir, consumer, env, expectedVersion = pkg.version) {
  const binMap = pkg.bin || {};
  for (const binName of Object.keys(binMap)) {
    const binPath = packageBin(binDir, binName);
    if (fs.existsSync(binPath)) ok(`bin present: ${binName}`);
    else fail(`${label}: declared bin is missing from the install: ${binName}`);
  }

  const version = run(packageBin(binDir, 'huqan'), ['--version'], { cwd: consumer, env });
  if (version.stdout.trim() === expectedVersion) ok(`huqan --version reports ${expectedVersion}`);
  else fail(`${label}: huqan --version said "${version.stdout.trim()}", expected "${expectedVersion}"`);
}

/**
 * quickstart must exit 0 AND print no module-load failure lines, then produce
 * a canonical Trust Receipt. Shared with verify-published-round-trip.js (#2631).
 */
function verifyQuickstart(label, binDir, consumer, env) {
  const quickstart = run(packageBin(binDir, 'huqan'), ['quickstart'], { cwd: consumer, env });
  if (quickstart.status !== 0) {
    fail(`${label}: quickstart exited ${quickstart.status}\n${quickstart.output.slice(-2000)}`);
  } else {
    // The point of the whole script: read the output, not the exit code.
    const loadErrors = quickstart.output.split(/\r?\n/)
      .filter((line) => LOAD_FAILURE_PATTERNS.some((pattern) => pattern.test(line)));
    if (loadErrors.length > 0) {
      fail(`${label}: quickstart succeeded but ${loadErrors.length} module(s) failed to load:\n`
        + loadErrors.map((line) => `      ${line.trim()}`).join('\n'));
    } else {
      ok('quickstart runs with no module load failures');
    }

    if (/status\s+:\s*canonical/.test(quickstart.output)) ok('quickstart produces a canonical Trust Receipt');
    else fail(`${label}: quickstart did not produce a canonical Trust Receipt`);
  }
}

function verifyExternalAdapters(label, consumer) {
  const root = path.join(consumer, 'node_modules', 'huqan', 'adapters', 'external-action');
  const required = [
    'claude-code-hooks.json',
    'codex-hooks.json',
    'opencode-plugin.mjs',
    'pi-extension.js',
    path.join('hermes', 'plugin.yaml'),
    path.join('hermes', '__init__.py'),
  ];
  const missing = required.filter((entry) => !fs.existsSync(path.join(root, entry)));
  if (missing.length === 0) ok('external agent adapter templates are present');
  else fail(`${label}: external adapter templates missing: ${missing.join(', ')}`);
}

module.exports = {
  verifyBinsAndVersion,
  verifyExternalAdapters,
  verifyQuickstart,
};
