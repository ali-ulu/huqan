'use strict';

// #3011: the graph incremental-save gate.
//
// Two kinds of threshold, deliberately separated because they fail for
// different reasons:
//
//   * Structural / ratio thresholds are machine-independent and ALWAYS
//     blocking. They encode the issue's claim: a save after one mutation must
//     write a tiny fraction of the rows a full checkpoint writes, and must do
//     measurably less work than a checkpoint on the same run. A machine being
//     slow changes both numbers together, so the ratio survives it; a machine
//     being slow does not resurrect write amplification.
//
//   * Absolute timings are machine-specific. They are advisory by default and
//     only blocking under `--strict-timing`, exactly as
//     benchmarks/check-regression.js treats its timing numbers. The nightly
//     full pass runs with `--strict-timing` and the ratio threshold, which is
//     the self-calibrating half that cannot flake on a slower runner.
//
// The baseline file pins the measured shape and the two ratio floors so a
// regression that reintroduces the full rewrite (incremental ~= checkpoint,
// rowReduction ~= 1) fails even when the absolute milliseconds look "normal".

const fs = require('fs');
const path = require('path');

const DEFAULT_MIN_ROW_REDUCTION = 1000;
const DEFAULT_MIN_SPEEDUP = 3;
const DEFAULT_MULTIPLIER = 4;
// One mutated node is one node row. Two is the tolerance for an endpoint node
// whose lastAccessed changed alongside the new node; anything more means the
// "incremental" path is rewriting unrelated rows.
const MAX_INCREMENTAL_ROWS = 2;

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function evaluateGraphSaveRegression(baseline, current, opts = {}) {
  const multiplier = opts.multiplier ?? DEFAULT_MULTIPLIER;
  const strictTiming = opts.strictTiming ?? false;
  const minRowReduction = opts.minRowReduction ?? DEFAULT_MIN_ROW_REDUCTION;
  const minSpeedup = opts.minSpeedup ?? DEFAULT_MIN_SPEEDUP;

  const blockingFailures = [];
  const advisoryFailures = [];

  for (const [fixtureName, baseFixture] of Object.entries(baseline.fixtures || {})) {
    const curFixture = current.fixtures?.[fixtureName];
    if (!curFixture) {
      blockingFailures.push(`Missing benchmark fixture: ${fixtureName}`);
      continue;
    }

    for (const field of ['nodes', 'edges']) {
      const curValue = curFixture[field];
      const baseValue = baseFixture[field];
      if (!isFiniteNumber(curValue) || !isFiniteNumber(baseValue)) {
        blockingFailures.push(`${fixtureName}.${field} is not numeric`);
        continue;
      }
      if (curValue < baseValue) {
        blockingFailures.push(`${fixtureName}.${field} regressed: ${curValue} < ${baseValue}`);
      }
    }

    if (!isFiniteNumber(curFixture.incrementalRows) || !isFiniteNumber(curFixture.checkpointRows)) {
      blockingFailures.push(`${fixtureName}: row counts are not numeric`);
      continue;
    }
    if (curFixture.incrementalRows > MAX_INCREMENTAL_ROWS) {
      blockingFailures.push(
        `${fixtureName}: one mutation wrote ${curFixture.incrementalRows} rows (max ${MAX_INCREMENTAL_ROWS}); the delta is not bounded`,
      );
    }
    if (!(curFixture.rowReduction >= minRowReduction)) {
      blockingFailures.push(
        `${fixtureName}: rowReduction ${curFixture.rowReduction}x < ${minRowReduction}x (incremental ${curFixture.incrementalRows} vs checkpoint ${curFixture.checkpointRows})`,
      );
    }

    const speedupFailure = isFiniteNumber(curFixture.writeRatio)
      ? curFixture.writeRatio < minSpeedup
        ? `${fixtureName}: incremental save is only ${curFixture.writeRatio}x faster than a checkpoint (< ${minSpeedup}x)`
        : null
      : `${fixtureName}: writeRatio is not numeric`;
    if (speedupFailure) {
      if (strictTiming) blockingFailures.push(speedupFailure);
      else advisoryFailures.push(speedupFailure);
    }

    const baseTiming = baseFixture.incrementalMs;
    if (isFiniteNumber(baseTiming) && isFiniteNumber(curFixture.incrementalMs)) {
      const limit = baseTiming * multiplier;
      if (curFixture.incrementalMs > limit) {
        const message = `${fixtureName}.incrementalMs: ${curFixture.incrementalMs.toFixed(3)}ms > ${limit.toFixed(3)}ms (baseline ${baseTiming.toFixed(3)}ms)`;
        if (strictTiming) blockingFailures.push(message);
        else advisoryFailures.push(message);
      }
    }
  }

  return {
    ok: blockingFailures.length === 0,
    blockingFailures,
    advisoryFailures,
    multiplier,
    minRowReduction,
    minSpeedup,
    strictTiming,
    mode: strictTiming ? 'strict-timing' : 'default',
  };
}

function printSummary(result, baseline, current) {
  const lines = [];
  lines.push('# Graph Incremental-Save Regression (#3011)');
  lines.push('');
  lines.push(`- Mode: ${result.mode}`);
  lines.push(`- Baseline version: ${baseline.version || 'unknown'}`);
  lines.push(`- Current iterations: ${current.iterations || 'unknown'}`);
  lines.push(`- Row-reduction floor: ${result.minRowReduction}x (blocking)`);
  lines.push(`- Speedup floor: ${result.minSpeedup}x (${result.strictTiming ? 'blocking' : 'advisory'})`);
  lines.push(`- Absolute timing multiplier: ${result.multiplier}x (${result.strictTiming ? 'blocking' : 'advisory'})`);
  lines.push('');

  const blockingCount = result.blockingFailures.length;
  const advisoryCount = result.advisoryFailures.length;
  lines.push(blockingCount === 0
    ? `Status: PASS${advisoryCount ? ` (advisory ${advisoryCount})` : ''}`
    : `Status: FAIL (blocking ${blockingCount}${advisoryCount ? ` + advisory ${advisoryCount}` : ''})`);

  for (const [fixtureName, fixture] of Object.entries(current.fixtures || {})) {
    lines.push('');
    lines.push(`- ${fixtureName}: checkpoint ${fixture.checkpointMs}ms / ${fixture.checkpointRows} rows, incremental ${fixture.incrementalMs}ms / ${fixture.incrementalRows} rows, speedup ${fixture.writeRatio}x, rowReduction ${fixture.rowReduction}x`);
  }

  if (blockingCount) {
    lines.push('');
    lines.push('## Blocking failures');
    for (const failure of result.blockingFailures) lines.push(`- ${failure}`);
  }
  if (advisoryCount) {
    lines.push('');
    lines.push('## Advisory warnings');
    for (const failure of result.advisoryFailures) lines.push(`- ${failure}`);
  }

  return `${lines.join('\n')}\n`;
}

if (require.main === module) {
  const positional = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
  const baselinePath = positional[0] || path.join(__dirname, 'graph-save-baseline.json');
  const currentPath = positional[1] || path.join(__dirname, 'graph-save-current.json');
  const multiplierArg = process.argv.find((arg) => arg.startsWith('--multiplier='));
  const minRowArg = process.argv.find((arg) => arg.startsWith('--min-row-reduction='));
  const minSpeedupArg = process.argv.find((arg) => arg.startsWith('--min-speedup='));
  const strictTiming = process.argv.includes('--strict-timing');

  const baseline = readJson(baselinePath);
  const current = readJson(currentPath);
  const result = evaluateGraphSaveRegression(baseline, current, {
    multiplier: multiplierArg ? Number(multiplierArg.split('=')[1]) : undefined,
    minRowReduction: minRowArg ? Number(minRowArg.split('=')[1]) : undefined,
    minSpeedup: minSpeedupArg ? Number(minSpeedupArg.split('=')[1]) : undefined,
    strictTiming,
  });
  process.stdout.write(printSummary(result, baseline, current));
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  evaluateGraphSaveRegression,
  printSummary,
  DEFAULT_MIN_ROW_REDUCTION,
  DEFAULT_MIN_SPEEDUP,
  DEFAULT_MULTIPLIER,
  MAX_INCREMENTAL_ROWS,
};
