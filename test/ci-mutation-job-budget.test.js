'use strict';

// #4320: the scheduled mutation job was reported as `cancelled` on main, but the
// check-run annotation read "The job has exceeded the maximum execution time of
// 1h0m0s". Every step had succeeded and the report was uploaded (2520 mutants);
// the job budget was below the work, not the other way round. Raising the budget
// is the fix, so the budget is pinned here: a revert to 60 re-breaks the nightly
// and must fail this test.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const WORKFLOW = fs.readFileSync(
  path.join(__dirname, '../.github/workflows/advanced-testing.yml'),
  'utf8',
);

// The old limit that killed the 2026-10-26 run. The budget must stay above it.
const OBSERVED_KILL_MINUTES = 60;

function jobBlock(name) {
  const start = WORKFLOW.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `job ${name} must exist in advanced-testing.yml`);
  const rest = WORKFLOW.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[a-z][\w-]*:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

test('the scheduled mutation job budget stays above the runtime that was killed', () => {
  const block = jobBlock('scheduled-mutation');
  const match = block.match(/^\s+timeout-minutes: (\d+)$/m);
  assert.ok(match, 'scheduled-mutation must declare an explicit timeout-minutes');
  const minutes = Number(match[1]);
  assert.ok(
    minutes > OBSERVED_KILL_MINUTES,
    `scheduled-mutation timeout ${minutes} min must exceed the ${OBSERVED_KILL_MINUTES} min limit that killed run 40286752227`,
  );
});

test('the scheduled mutation job still runs the full suite, not a slice', () => {
  const block = jobBlock('scheduled-mutation');
  assert.match(
    block,
    /run: npm run test:mutation/,
    'the budget must not be met by dropping the full mutation suite',
  );
});
