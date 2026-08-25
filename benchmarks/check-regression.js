const fs = require('fs');
const path = require('path');

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function evaluateRegression(baseline, current, opts = {}) {
  const metrics = opts.metrics || ['learn', 'ask', 'verify', 'reason', 'compare', 'dream'];
  const allowedMultiplier = opts.allowedMultiplier ?? 1.75;
  const strictTiming = opts.strictTiming ?? false;
  const failures = [];
  const blockingFailures = [];
  const advisoryFailures = [];

  for (const [fixtureName, baseFixture] of Object.entries(baseline.fixtures || {})) {
    const curFixture = (current.results || []).find(item => item.label === fixtureName);
    if (!curFixture) {
      const message = `Missing benchmark fixture: ${fixtureName}`;
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

    for (const metric of metrics) {
      const curValue = curFixture?.[metric]?.avgMs;
      const baseValue = baseFixture?.[metric];
      if (!isFiniteNumber(curValue) || !isFiniteNumber(baseValue)) {
        const message = `${fixtureName}.${metric} is not numeric`;
        failures.push(message);
        blockingFailures.push(message);
        continue;
      }
      const limit = baseValue * allowedMultiplier;
      if (curValue > limit) {
        const message = `${fixtureName}.${metric}: ${curValue.toFixed(3)}ms > ${limit.toFixed(3)}ms (baseline ${baseValue.toFixed(3)}ms)`;
        failures.push(message);
        if (strictTiming) {
          blockingFailures.push(message);
        } else {
          advisoryFailures.push(message);
        }
      }
    }
  }

  return {
    ok: blockingFailures.length === 0,
    blockingFailures,
    advisoryFailures,
    failures,
    allowedMultiplier,
    mode: strictTiming ? 'strict-timing' : 'default',
  };
}

function printSummary(result, baseline, current) {
  const lines = [];
  lines.push('# Benchmark Regression');
  lines.push('');
  lines.push(`- Mode: ${result.mode || 'default'}`);
  lines.push(`- Allowed multiplier: ${result.allowedMultiplier}x`);
  lines.push(`- Baseline version: ${baseline.version || 'unknown'}`);
  lines.push(`- Current iterations: ${current.iterations || 'unknown'}`);
  lines.push('');

  const blockingCount = result.blockingFailures?.length || 0;
  const advisoryCount = result.advisoryFailures?.length || 0;
  if (blockingCount === 0) {
    lines.push(`Status: PASS${advisoryCount ? ` (advisory ${advisoryCount})` : ''}`);
  } else {
    lines.push(`Status: FAIL (blocking ${blockingCount}${advisoryCount ? ` + advisory ${advisoryCount}` : ''})`);
    lines.push('');
    lines.push('## Blocking failures');
    for (const failure of result.blockingFailures || []) {
      lines.push(`- ${failure}`);
    }
    if (advisoryCount) {
      lines.push('');
      lines.push('## Advisory timing warnings');
      for (const failure of result.advisoryFailures || []) {
        lines.push(`- ${failure}`);
      }
    }
  }

  return `${lines.join('\n')}\n`;
}

if (require.main === module) {
  const baselinePath = process.argv[2] || path.join(__dirname, 'results.json');
  const currentPath = process.argv[3] || path.join(__dirname, 'current-results.json');
  const allowedMultiplierArg = process.argv.find(arg => arg.startsWith('--multiplier='));
  const allowedMultiplier = allowedMultiplierArg ? Number(allowedMultiplierArg.split('=')[1]) : 1.75;
  const strictTiming = process.argv.includes('--strict-timing');

  const baseline = readJson(baselinePath);
  const current = readJson(currentPath);
  const result = evaluateRegression(baseline, current, { allowedMultiplier, strictTiming });
  const summary = printSummary(result, baseline, current);
  process.stdout.write(summary);

  if (result.blockingFailures.length > 0) process.exit(1);
}

module.exports = {
  evaluateRegression,
  printSummary,
};
