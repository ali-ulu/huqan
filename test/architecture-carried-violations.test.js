'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildDependencySnapshot, checkDependencyGraph } = require('../scripts/architecture-dependency-graph');
const { isSplitOf, pairCarriedViolations } = require('../scripts/architecture-carried-violations');

// Core lib/*.js requiring an Application module is a recorded-violation shape
// the real tree has (#2826: github-app-streaming-trust-store -> receipt/canonical-receipt).
const TARGET = 'lib/receipt/canonical-receipt.js';
const OLD = 'lib/trust-store.js';

function snapshot(graph) {
  return buildDependencySnapshot(new Map(Object.entries(graph)));
}

function recordedFrom(graph) {
  const snap = snapshot(graph);
  return { threshold: 50, layers: snap.layers, edges: snap.edges, violations: snap.violations };
}

const BEFORE = { [OLD]: [TARGET], [TARGET]: [] };
const check = (current, baseline, argv = [], previous = null) => checkDependencyGraph(current, baseline, argv, previous, []);
const failures = (result) => result.messages.filter((message) => message.startsWith('FAIL'));

test('a split file may name the original with a dash or a directory, nothing else', () => {
  assert.equal(isSplitOf('lib/trust-store-records.js', OLD), true);
  assert.equal(isSplitOf('lib/trust-store/records.js', OLD), true);
  assert.equal(isSplitOf('lib/trust-storefront.js', OLD), false);
  assert.equal(isSplitOf('lib/other-trust-store.js', OLD), false);
  assert.equal(isSplitOf(OLD, OLD), false);
});

test('a violation carried into a file split out of the original is neither new debt nor a gain', () => {
  const current = snapshot({ [OLD]: ['lib/trust-store-records.js'], 'lib/trust-store-records.js': [TARGET], [TARGET]: [] });

  const result = check(current, recordedFrom(BEFORE));

  assert.deepEqual(failures(result), []);
  assert.equal(result.ok, true);
});

test('an unrelated new file cannot use a vanished violation to hide a new one', () => {
  const current = snapshot({ [OLD]: [], 'lib/unrelated.js': [TARGET], [TARGET]: [] });

  const result = check(current, recordedFrom(BEFORE));

  assert.ok(failures(result).some((message) => /new layer violation/.test(message)));
  assert.ok(failures(result).some((message) => /unrecorded gain/.test(message)));
});

test('a file the record already knows cannot take over a vanished violation', () => {
  const known = { ...BEFORE, 'lib/trust-store-records.js': [] };
  const current = snapshot({ [OLD]: [], 'lib/trust-store-records.js': [TARGET], [TARGET]: [] });

  const result = check(current, recordedFrom(known));

  assert.ok(failures(result).some((message) => /new layer violation/.test(message)));
});

test('one vanished violation carries exactly one new edge; a second is new debt', () => {
  const current = snapshot({
    [OLD]: ['lib/trust-store-records.js', 'lib/trust-store-files.js'],
    'lib/trust-store-records.js': [TARGET],
    'lib/trust-store-files.js': [TARGET],
    [TARGET]: [],
  });

  const result = check(current, recordedFrom(BEFORE));
  const added = failures(result).find((message) => /new layer violation/.test(message));

  assert.match(added, /\(1\)/);
});

test('a carried edge must leave the same ring as the one it replaces', () => {
  const pairing = pairCarriedViolations(
    [{ from: 'lib/trust-store/records.js', to: TARGET, fromLayer: 'Adapters', toLayer: 'Application' }],
    [{ from: OLD, to: TARGET, fromLayer: 'Core', toLayer: 'Application' }],
    {},
  );

  assert.equal(pairing.carried.length, 0);
  assert.equal(pairing.unexplained.length, 1);
  assert.equal(pairing.stillGone.length, 1);
});

test('after --update, the base-ref ratchet accepts the carried edge but not an extra one', () => {
  const previous = recordedFrom(BEFORE);
  const split = { [OLD]: ['lib/trust-store-records.js'], 'lib/trust-store-records.js': [TARGET], [TARGET]: [] };
  const updated = check(snapshot(split), previous, ['--update']).recorded;

  assert.ok(updated, 'the split should be recordable with --update');
  assert.deepEqual(failures(check(snapshot(split), updated, [], previous)), []);

  const smuggled = { ...updated, violations: [...updated.violations, ...previous.violations] };
  assert.ok(failures(check(snapshot(split), smuggled, [], previous))
    .some((message) => /baseline cannot add debt|unrecorded gain/.test(message)));
});
