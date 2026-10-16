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
});

  it('nodes and edges must be finite numbers before regression comparison', () => {
    const baseline = { fixtures: { small: makeBaselineFixture() } };
    const cases = [
      {
        name: 'missing nodes and edges',
        mutate(current) {
          delete current.nodes;
          delete current.edges;
        },
        expected: ['small.nodes is not numeric', 'small.edges is not numeric'],
      },
      {
        name: 'null nodes',
        mutate(current) {
          current.nodes = null;
        },
        expected: ['small.nodes is not numeric'],
      },
      {
        name: 'non-numeric edges',
        mutate(current) {
          current.edges = 'çok';
        },
        expected: ['small.edges is not numeric'],
      },
    ];

    for (const testCase of cases) {
      const current = makeCurrentFixture();
      testCase.mutate(current);
      const result = evaluateRegression(baseline, { results: [current] });
      assert.strictEqual(result.ok, false, testCase.name);
      for (const expected of testCase.expected) {
        assert.ok(result.blockingFailures.includes(expected), `${testCase.name}: ${expected}`);
      }
      assert.ok(
        result.blockingFailures.every(message => !message.includes('regressed:')),
        `${testCase.name} must not be reported as a numeric regression`,
      );
    }
  });
