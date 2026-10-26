'use strict';

// #4320: the scheduled mutation suite ran 60.0 min and was killed at the job
// limit -- all steps had succeeded, the budget was simply below the runtime.
// The mutant count grows with the security surface on purpose, so the suite has
// to run wider than one worker at a time to stay inside any sane budget. The
// GitHub-hosted ubuntu runner has 4 vCPUs, so 4 is the useful ceiling; a revert
// to a serial-ish 2 re-slows the nightly, and this test says so.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const config = JSON.parse(
  fs.readFileSync(path.join(__dirname, '../stryker.conf.json'), 'utf8'),
);

const MIN_CONCURRENCY = 4;

test('the mutation run uses the runner CPUs, not two of them', () => {
  assert.ok(
    Number.isInteger(config.concurrency) && config.concurrency > 0,
    'stryker.conf.json must declare a positive integer concurrency',
  );
  assert.ok(
    config.concurrency >= MIN_CONCURRENCY,
    `concurrency ${config.concurrency} leaves the nightly mutation suite on the wrong side of its budget`,
  );
});
