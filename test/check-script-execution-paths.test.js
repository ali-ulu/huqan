'use strict';

/**
 * #3418: a `check:*` script that nothing runs is a governance claim without an
 * execution path.
 *
 * The repository declares its quality gates as `npm run check:<name>` scripts.
 * A gate is only real if some automated path runs it, and the path that rots is
 * the CI workflow: a script lands, the author runs it by hand, and no workflow
 * ever calls it. This is what happened to `check:enforcement-coverage` and
 * `check:benign-false-block-rate`, which ran only through the tests that
 * imported their functions -- a coupling that can stay green while the gate's
 * own scan path is broken.
 *
 * So this pins the invariant: every `check:*` must be reachable from a CI
 * workflow or from `scripts/verify-suite.js` (the documented `npm run verify`
 * manifest). A test import is deliberately NOT accepted as an execution path,
 * for the reason above.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const repoRoot = path.join(__dirname, '..');

function readWorkflowTexts() {
  const directory = path.join(repoRoot, '.github', 'workflows');
  return fs.readdirSync(directory)
    .filter((file) => /\.ya?ml$/i.test(file))
    .map((file) => fs.readFileSync(path.join(directory, file), 'utf8'));
}

function scriptPathOf(command) {
  const match = command.match(/(?:^|\s)(scripts\/[\w./-]+\.js)/);
  return match ? match[1] : null;
}

function executionPathTexts() {
  return [...readWorkflowTexts(), fs.readFileSync(path.join(repoRoot, 'scripts', 'verify-suite.js'), 'utf8')];
}

test('every check:* script has a CI workflow or verify-suite execution path', () => {
  const scripts = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')).scripts;
  const checks = Object.entries(scripts).filter(([name]) => name.startsWith('check:'));
  assert.ok(checks.length > 0, 'package.json must declare check:* scripts');

  const haystacks = executionPathTexts();
  const orphans = [];
  for (const [name, command] of checks) {
    const scriptPath = scriptPathOf(command);
    const scriptBase = scriptPath ? path.basename(scriptPath) : null;
    const referenced = haystacks.some(
      (text) => text.includes(name) || (scriptBase !== null && text.includes(scriptBase)),
    );
    if (!referenced) orphans.push(`${name} (${scriptPath || command})`);
  }

  assert.deepEqual(orphans, [],
    'these check:* scripts are declared but no workflow or verify-suite stage runs them, '
    + 'so an operator running the documented gates never reaches them:\n  '
    + orphans.join('\n  '));
});
