const { describe, it } = require('node:test');
const assert = require('node:assert');
const { evaluateRegression, printSummary } = require('./check-regression');

function makeBaselineFixture(overrides = {}) {
  return {
    nodes: 5,
    edges: 4,
    learn: 10,
    ask: 2,
    verify: 2,
    reason: 2,
    compare: 2,
    dream: 5,
    ...overrides,
  };
}

function makeCurrentFixture(overrides = {}) {
  return {
    label: 'small',
    nodes: 5,
    edges: 4,
    learn: { avgMs: 12 },
    ask: { avgMs: 2.2 },
    verify: { avgMs: 2.1 },
    reason: { avgMs: 1.9 },
    compare: { avgMs: 1.8 },
    dream: { avgMs: 5.5 },
    ...overrides,
  };
}

describe('benchmark regression checker', () => {
  it('passes when current metrics are under threshold', () => {
    const baseline = {
      version: '2.0.0',
      fixtures: {
        small: makeBaselineFixture(),
      },
    };
    const current = {
      iterations: 2,
      results: [makeCurrentFixture()],
    };
    const result = evaluateRegression(baseline, current, { allowedMultiplier: 1.75 });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.failures, []);
    assert.deepStrictEqual(result.blockingFailures, []);
    assert.deepStrictEqual(result.advisoryFailures, []);
    assert.strictEqual(result.mode, 'default');
  });

  it('fails when metric exceeds threshold', () => {
    const baseline = {
      version: '2.0.0',
      fixtures: {
        small: makeBaselineFixture(),
      },
    };
    const current = {
      iterations: 2,
      results: [makeCurrentFixture({ learn: { avgMs: 30 } })],
    };
    const result = evaluateRegression(baseline, current, { allowedMultiplier: 1.75 });
    assert.strictEqual(result.ok, true);
    assert.ok(result.failures.some(line => line.includes('small.learn')));
    assert.deepStrictEqual(result.blockingFailures, []);
    assert.ok(result.advisoryFailures.some(line => line.includes('small.learn')));
  });

  it('default mode: timing failure is advisory, ok=true', () => {
    const baseline = { fixtures: { small: makeBaselineFixture() } };
    const current = {
      iterations: 2,
      results: [makeCurrentFixture({ verify: { avgMs: 8 } })],
    };
    const result = evaluateRegression(baseline, current, { allowedMultiplier: 1.75 });
    assert.strictEqual(result.ok, true);
    assert.deepStrictEqual(result.blockingFailures, []);
    assert.ok(result.advisoryFailures.some(line => line.includes('small.verify')));
    assert.ok(result.failures.some(line => line.includes('small.verify')));
    assert.strictEqual(result.mode, 'default');
  });

  it('strict-timing mode: timing failure is blocking, ok=false', () => {
    const baseline = { fixtures: { small: makeBaselineFixture() } };
    const current = {
      iterations: 2,
      results: [makeCurrentFixture({ verify: { avgMs: 8 } })],
    };
    const result = evaluateRegression(baseline, current, { allowedMultiplier: 1.75, strictTiming: true });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blockingFailures.some(line => line.includes('small.verify')));
    assert.deepStrictEqual(result.advisoryFailures, []);
    assert.strictEqual(result.mode, 'strict-timing');
  });

  it('default mode: nodes regression is blocking, ok=false', () => {
    const baseline = { fixtures: { small: makeBaselineFixture() } };
    const current = {
      iterations: 2,
      results: [makeCurrentFixture({ nodes: 4 })],
    };
    const result = evaluateRegression(baseline, current, { allowedMultiplier: 1.75 });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blockingFailures.some(line => line.includes('nodes regressed')));
  });

  it('default mode: missing fixture is blocking, ok=false', () => {
    const baseline = { fixtures: { small: makeBaselineFixture(), medium: makeBaselineFixture() } };
    const current = {
      iterations: 2,
      results: [makeCurrentFixture()],
    };
    const result = evaluateRegression(baseline, current, { allowedMultiplier: 1.75 });
    assert.strictEqual(result.ok, false);
    assert.ok(result.blockingFailures.some(line => line.includes('Missing benchmark fixture: medium')));
  });

  it('printSummary separates blocking and advisory failures', () => {
    const baseline = {
      version: '2.0.0',
      fixtures: { small: makeBaselineFixture() },
    };
    const current = {
      iterations: 2,
      results: [makeCurrentFixture({ nodes: 4, verify: { avgMs: 8 } })],
    };
    const result = evaluateRegression(baseline, current, { allowedMultiplier: 1.75 });
    const summary = printSummary(result, baseline, current);
    assert.match(summary, /Mode: default/);
    assert.match(summary, /Status: FAIL \(blocking 1 \+ advisory 1\)/);
    assert.match(summary, /## Blocking failures/);
    assert.match(summary, /## Advisory timing warnings/);
  });

  // #1551: nodes/edges were compared directly while the metric loop four lines
  // below used isFiniteNumber. `undefined < 5` and `"cok" < 5` are false, so a
  // truncated or malformed result read as "no regression" and passed the gate.
  describe('#1551 nodes/edges are checked for numericness before comparison', () => {
    const baseline = { version: '2.0.0', fixtures: { small: makeBaselineFixture() } };
    const evaluate = (overrides) => evaluateRegression(baseline, {
      iterations: 2,
      results: [makeCurrentFixture(overrides)],
    });

    it('a healthy result still passes', () => {
      assert.strictEqual(evaluate({}).ok, true);
    });

    it('a real regression is still reported as a regression', () => {
      const result = evaluate({ nodes: 4 });
      assert.strictEqual(result.ok, false);
      assert.deepStrictEqual(result.blockingFailures, ['small.nodes regressed: 4 < 5']);
    });

    it('a missing field blocks instead of passing silently', () => {
      for (const field of ['nodes', 'edges']) {
        const result = evaluate({ [field]: undefined });
        assert.strictEqual(result.ok, false, `a missing ${field} must not pass the gate`);
        assert.deepStrictEqual(result.blockingFailures, [`small.${field} is not numeric`]);
      }

      // Both missing: each is reported on its own, not collapsed into one.
      const result = evaluate({ nodes: undefined, edges: undefined });
      assert.deepStrictEqual(result.blockingFailures, ['small.nodes is not numeric', 'small.edges is not numeric']);
    });

    it('a non-numeric value blocks', () => {
      for (const bad of ['cok', true, {}, []]) {
        const result = evaluate({ nodes: bad });
        assert.strictEqual(result.ok, false, `nodes: ${JSON.stringify(bad)} must not pass the gate`);
        assert.deepStrictEqual(result.blockingFailures, ['small.nodes is not numeric']);
      }
    });

    it('null is rejected as a broken field, not reported as a regressed value', () => {
      // This case already failed, but for the wrong reason: null coerces to 0,
      // so it read as "regressed to null" rather than "the field is broken".
      const result = evaluate({ nodes: null });
      assert.strictEqual(result.ok, false);
      assert.deepStrictEqual(result.blockingFailures, ['small.nodes is not numeric']);
    });

    it('a broken baseline field blocks too, not just a broken current one', () => {
      const brokenBaseline = { version: '2.0.0', fixtures: { small: makeBaselineFixture({ edges: undefined }) } };
      const result = evaluateRegression(brokenBaseline, { iterations: 2, results: [makeCurrentFixture()] });
      assert.strictEqual(result.ok, false);
      assert.deepStrictEqual(result.blockingFailures, ['small.edges is not numeric']);
    });
  });
});
