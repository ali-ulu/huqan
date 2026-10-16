'use strict';

// #3016 gate for benchmarks/scale-10k-baseline.json.
//
// Blocking on every run (shape contract):
// - every baseline fixture is present in the current run;
// - current nodes/edges are not below the baseline (no silent record loss).
//
// Advisory by default, blocking under --strict-timing (what the nightly job
// uses): learn/ask/verify/save wall-clock within 4x of the baseline and heap
// delta within 4x. Timings and heap are machine-dependent, so a red nightly
// on the timing half alone means a slow runner; a red run on the shape half
// means a real regression.

const fs = require('fs');

const TIMING_FIELDS = ['seedMs', 'askMs', 'verifyMs', 'reasonMs', 'saveMs'];
const HEAP_FIELDS = ['heapDeltaMB'];
const STRICT_MULTIPLIER = 4;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function checkScale(baseline, current, opts = {}) {
  const strictTiming = opts.strictTiming ?? false;
  const failures = [];
  const blockingFailures = [];
  const advisoryFailures = [];

  for (const [fixtureName, baseFixture] of Object.entries(baseline.fixtures || {})) {
    const curFixture = (current.fixtures || {})[fixtureName];
    if (!curFixture) {
      const message = `Missing scale fixture: ${fixtureName}`;
      failures.push(message);
      blockingFailures.push(message);
      continue;
    }

    for (const field of ['nodes', 'edges']) {
      const curValue = curFixture[field];
      const baseValue = baseFixture[field];
      if (!isFiniteNumber(curValue) || !isFiniteNumber(baseValue)) {
        const message = `${fixtureName}.${field} is not numeric`;
        failures.push(message);
        blockingFailures.push(message);
        continue;
      }
      if (curValue < baseValue) {
        const message = `${fixtureName}.${field} regressed: ${curValue} < ${baseValue}`;
        failures.push(message);
        blockingFailures.push(message);
      }
    }

    for (const field of [...TIMING_FIELDS, ...HEAP_FIELDS]) {
      const curValue = curFixture[field];
      const baseValue = baseFixture[field];
      if (!isFiniteNumber(curValue) || !isFiniteNumber(baseValue)) {
        const message = `${fixtureName}.${field} is not numeric`;
        failures.push(message);
        blockingFailures.push(message);
        continue;
      }
      if (baseValue <= 0) continue;
      const limit = baseValue * STRICT_MULTIPLIER;
      if (curValue > limit) {
        const message = `${fixtureName}.${field}: ${curValue}ms/MB > ${limit.toFixed(3)} (baseline ${baseValue})`;
        failures.push(message);
        if (strictTiming) blockingFailures.push(message);
        else advisoryFailures.push(message);
      }
    }
  }

  return { failures, blockingFailures, advisoryFailures, strictTiming };
}

if (require.main === module) {
  const argv = process.argv.slice(2).filter((arg) => arg !== '--strict-timing');
  const strictTiming = process.argv.includes('--strict-timing');
  if (argv.length < 2) {
    console.error('Usage: node benchmarks/check-scale-10k.js <baseline.json> <current.json> [--strict-timing]');
    process.exit(2);
  }
  const baseline = readJson(argv[0]);
  const current = readJson(argv[1]);
  const { failures, blockingFailures, advisoryFailures } = checkScale(baseline, current, { strictTiming });
  for (const message of advisoryFailures) console.log(`ADVISORY: ${message}`);
  if (blockingFailures.length > 0) {
    for (const message of blockingFailures) console.error(`FAIL: ${message}`);
    process.exit(1);
  }
  if (failures.length === 0) console.log('OK: scale fixtures match the baseline shape.');
  else console.log('OK (advisory only): shape matches; timing drift is within the non-strict gate.');
}

module.exports = { checkScale, TIMING_FIELDS, HEAP_FIELDS, STRICT_MULTIPLIER };
