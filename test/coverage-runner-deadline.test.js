'use strict';

/**
 * The coverage measurement must run through the shard runner, not
 * scripts/run-tests.js (#8339).
 *
 * `npm run coverage` used to spawn `scripts/run-tests.js`, a thin wrapper over
 * `node --test` with no per-file deadline. One file that hangs therefore ran
 * until the Coverage job's 45-minute cap and the job was cancelled with no
 * summary. On 2026-11-10 that is what happened (main run #8339): the run was
 * cancelled after ~45 minutes, the coverage alarm could not be cleared by a
 * later skip, and the next three source commits (#4573, #4577, #4579) inherited
 * a red check that was not theirs.
 *
 * scripts/run-test-shard.js runs every file under the same per-file deadline
 * the runtime shards use -- 90s, 240s for a heavy file, plus the scoped
 * overrides in scripts/heavy-test-files.js -- and logs a hanging file's process
 * tree (#2814). Running it as shard 1/1 keeps the same file set (its discovery
 * matches `node --test`) while bounding any single file, so a hang can no longer
 * consume the whole job budget.
 *
 * These assertions pin that wiring so a revert to the deadline-less runner
 * cannot land quietly.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const REPO_ROOT = path.join(__dirname, '..');
const packageJson = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'));
const coverageScript = packageJson.scripts.coverage;

test('the coverage script measures through the per-file deadline runner', () => {
  assert.match(
    coverageScript,
    /node scripts\/run-test-shard\.js --shard=1 --total=1 --concurrency=1\b/,
    'npm run coverage must run scripts/run-test-shard.js as shard 1/1',
  );
  assert.doesNotMatch(
    coverageScript,
    /node scripts\/run-tests\.js\b/,
    'the deadline-less scripts/run-tests.js must not drive the coverage measurement',
  );
});

test('the coverage script still measures with c8 under the collector heap cap', () => {
  assert.match(coverageScript, /node_modules\/c8\/bin\/c8\.js/);
  assert.match(coverageScript, /--max-old-space-size=8192/);
});

test('the Coverage job still measures through npm run coverage', () => {
  const workflow = fs.readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'benchmark.yml'), 'utf8');
  const step = workflow.slice(workflow.indexOf('- name: Measure the suite under c8'));
  const run = step.slice(0, step.indexOf('- name: Enforce the coverage ratchet'));
  assert.match(run, /npm run coverage/, 'the coverage job must invoke the script these assertions pin');
});
