'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const Kernel = require('../kernel');

// #1744 / #1751: `_commitBackgroundEdge` turns a null admission into an
// explicit allow when — and only when — the caller asked for a bypass.
//
// The security property this file pins is NOT "a bypass exists". It is that
// the bypass is still reachable only through the module-private Symbol that
// #357 introduced: `admission === null` is returned by
// _evaluateLearnAdmission exclusively for a genuine
// Kernel.createAdmissionBypassOpts() object, so the plain-string
// `admissionBypassReason` that the passthrough also inspects can narrow the
// condition but can never widen it. A regression that relaxed the Symbol
// check into a string check would make forged, JSON-decodable opts sufficient
// to write unreviewed edges — exactly the hole #357 closed — and the third
// test below is what would catch it.

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-dream-bypass-'));
  const kernel = new Kernel({
    graphPath: path.join(dir, 'graph.json'),
    enableConcurrencyLock: false,
  });
  // addEdge is a no-op returning null unless both endpoints already exist in
  // the workspace, so seed them; otherwise "no edge written" would pass for
  // the wrong reason and the gated/allowed cases would be indistinguishable.
  kernel.graph.addNode('alpha', 'alpha', null, { workspaceId: 'default' });
  kernel.graph.addNode('beta', 'beta', null, { workspaceId: 'default' });
  return { kernel, dir };
}

function commit(kernel, opts) {
  return kernel._commitBackgroundEdge('alpha', 'beta', 'hipotez', 'dream', opts);
}

test('default dream edge stays admission-gated and writes no edge', () => {
  const { kernel } = fixture();

  const result = commit(kernel, { workspaceId: 'default' });

  assert.notEqual(result.decision, 'allow', 'a dream hypothesis must not self-approve by default');
  assert.equal(result.edge, null, 'a non-allow decision must not write an edge');
});

test('a genuine createAdmissionBypassOpts token turns the gated edge into an audited allow', () => {
  const { kernel } = fixture();

  const result = commit(kernel, {
    workspaceId: 'default',
    admissionOpts: Kernel.createAdmissionBypassOpts('local operator-directed dream verification'),
  });

  assert.equal(result.decision, 'allow');
  assert.ok(result.edge, 'an allowed bypass must actually write the edge');
  assert.equal(result.admission.reason, 'local_admission_bypass_requested');
  assert.equal(
    result.audit.details.reason ?? result.audit.details.admissionOutcome,
    result.audit.details.reason ?? 'allow',
    'the allow must leave an audit record',
  );
});

test('a forged plain-object admissionBypassReason does NOT bypass admission (#357)', () => {
  const { kernel } = fixture();

  // Exactly what an HTTP body, MCP tool argument or CLI argv would decode to:
  // the string field is present, the Symbol cannot be. This is also what
  // JSON.parse(JSON.stringify(createAdmissionBypassOpts(...))) produces.
  const forged = JSON.parse(JSON.stringify(
    Kernel.createAdmissionBypassOpts('pretending to be an operator'),
  ));
  assert.equal(forged.admissionBypassReason, 'pretending to be an operator');

  const result = commit(kernel, { workspaceId: 'default', admissionOpts: forged });

  assert.notEqual(
    result.decision,
    'allow',
    'a string-only bypass reason must not be sufficient to write an edge',
  );
  assert.equal(result.edge, null);
});
