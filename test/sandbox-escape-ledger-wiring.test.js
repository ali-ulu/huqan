'use strict';

/**
 * Wiring proof for the sandbox escape ledger (#1891).
 *
 * Two things need proving, and they are different:
 *
 *  1. The runner's verdict has the shape the ledger accepts. This is the real
 *     integration risk -- `meta.ab6` and the ledger event were written by
 *     different changes and nothing forced them to agree.
 *  2. The self-healer caller forwards the verdict rather than dropping it, as
 *     it did before this change.
 *
 * What is NOT claimed: that the simulator ever records anything on its own. Its
 * sandbox source is a literal it declares `validated`, so AB6 answers `allow`
 * and nothing is written. That is correct behaviour, not a gap, and the test
 * below pins it so nobody later reads an empty ledger as a broken wire. The
 * runner records instead, whenever any caller hands it a graph (#2505 G).
 * That recording lives in lib/sandbox-escape-producer.js rather than in
 * sandboxRunner.js itself, which is over the large-file threshold (#328).
 */

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Graph = require('../graph');
const { runSandboxed } = require('../sandboxRunner');
const { createSandboxEscapeProducer } = require('../lib/sandbox-escape-producer');
const { recordSandboxVerdict, readSandboxEscapes } = require('../lib/sandbox-escape-ledger');
const { simulateInSandbox } = require('../lib/self-healer/source-dogfood-simulator');

function makeTempGraph() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-sandbox-wire-'));
  const graph = new Graph({ useSQLite: false, memoryPath: path.join(dir, 'memory.json') });
  return { graph, dir };
}

const DEPENDENCY_GRAPH = {
  nodes: ['a.js', 'b.js'],
  edges: [],
};
const CANDIDATE = { from: 'a.js', to: 'b.js', candidateId: 'c1', confidence: 0.6, hypothesisType: 'test' };

// The collaborator is handed in, mirroring the production wiring: the inner
// producer ring may not require the outer runner (layer check).
const { runSandboxedWithEscapeRecording } = createSandboxEscapeProducer({ runSandboxed });

test('an untrusted source really does produce a quarantine verdict the ledger accepts', () => {
  const { graph, dir } = makeTempGraph();
  try {
    // No sourceTrust declared, so AB6 answers `quarantine` rather than assuming
    // trust. This is the shape the wire carries when there is something to say.
    const result = runSandboxed('(() => ({ ok: true }))()', {}, {});

    assert.equal(result.meta.ab6.decision, 'quarantine');
    assert.equal(result.meta.ab6.reason, 'UNKNOWN_SOURCE_TRUST_QUARANTINE');

    const recorded = recordSandboxVerdict({
      graph,
      verdict: result.meta.ab6,
      workspaceId: 'workspace-a',
      sourceRef: 'test:untrusted-source',
    });

    assert.ok(recorded, "the runner's verdict must be recordable as-is");
    const escapes = readSandboxEscapes(graph);
    assert.equal(escapes.length, 1);
    assert.equal(escapes[0].reason, 'UNKNOWN_SOURCE_TRUST_QUARANTINE');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('this call site writes nothing, and the reason is its verdict, not a missing wire', () => {
  // Read this as documentation, not as a wiring proof: it would also pass if
  // the recorder call were deleted. It cannot be stronger, and pretending
  // otherwise is worse than saying so -- the simulator's source is a literal it
  // declares `validated`, AB6 answers `allow`, and an allow is not an escape.
  //
  // The assertion that matters is the second one: it pins WHY the ledger is
  // empty. If AB6 ever starts answering something else for this call site, this
  // test fails and the empty ledger stops being the expected outcome.
  const { graph, dir } = makeTempGraph();
  try {
    const sandbox = simulateInSandbox(DEPENDENCY_GRAPH, CANDIDATE, {
      graph,
      workspaceId: 'workspace-a',
    });
    assert.equal(sandbox.ok, true, 'supplying a graph must not change the simulation');

    const sameVerdict = runSandboxed('(() => ({ ok: true }))()', {}, { sourceTrust: 'validated' });
    assert.equal(sameVerdict.meta.ab6.decision, 'allow');
    assert.equal(sameVerdict.meta.ab6.reason, 'SOURCE_VALIDATED_ALLOW');

    assert.deepEqual(readSandboxEscapes(graph), [], 'an allow verdict is correctly not recorded');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a validated source is still recorded when the runner blocks it for another reason', () => {
  // The escape branch is not reachable *through the simulator* today, but it is
  // not exclusive to untrusted sources either: AB6 blocks a validated source
  // whose timeout exceeds policy. The runner itself records when it is given a
  // graph (#2505 G) -- no caller has to persist `meta.ab6` by hand.
  const { graph, dir } = makeTempGraph();
  try {
    const result = runSandboxedWithEscapeRecording('(() => ({ ok: true }))()', {}, {
      sourceTrust: 'validated',
      timeoutMs: 60000,
      graph,
      workspaceId: 'workspace-a',
      sourceRef: 'test:validated-timeout',
    });
    assert.equal(result.meta.ab6.decision, 'block');
    assert.equal(result.meta.ab6.reason, 'TIMEOUT_EXCEEDED_BLOCK');

    const escapes = readSandboxEscapes(graph);

    assert.equal(escapes.length, 1);
    assert.equal(escapes[0].decision, 'block');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the simulator still works when no graph is supplied', () => {
  const sandbox = simulateInSandbox(DEPENDENCY_GRAPH, CANDIDATE);

  assert.equal(sandbox.ok, true);
});

// #2505 G: the producer records at the runner, not at each call site --------

test('the producer records a block verdict when given a graph', () => {
  const { graph, dir } = makeTempGraph();
  try {
    const result = runSandboxedWithEscapeRecording('(() => ({ ok: true }))()', {}, {
      sourceTrust: 'untrusted',
      graph,
      workspaceId: 'workspace-a',
      sourceRef: 'test:producer',
    });
    assert.equal(result.ok, false);
    assert.equal(result.meta.ab6.decision, 'block');
    const escapes = readSandboxEscapes(graph);
    assert.equal(escapes.length, 1);
    assert.equal(escapes[0].decision, 'block');
    assert.equal(escapes[0].workspaceId, 'workspace-a');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the producer records a quarantine and nothing for an allow', () => {
  const { graph, dir } = makeTempGraph();
  try {
    const quarantined = runSandboxedWithEscapeRecording('(() => ({ ok: true }))()', {}, { graph });
    assert.equal(quarantined.meta.ab6.decision, 'quarantine');
    const allowed = runSandboxedWithEscapeRecording('(() => ({ ok: true }))()', {}, {
      sourceTrust: 'validated',
      graph,
    });
    assert.equal(allowed.meta.ab6.decision, 'allow');
    const escapes = readSandboxEscapes(graph);
    assert.equal(escapes.length, 1, 'only the quarantine is recorded');
    assert.equal(escapes[0].decision, 'quarantine');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without a graph the verdict travels exactly as before', () => {
  const result = runSandboxedWithEscapeRecording('(() => ({ ok: true }))()', {}, { sourceTrust: 'untrusted' });
  assert.equal(result.ok, false);
  assert.equal(result.meta.ab6.decision, 'block');
  assert.equal(result.meta.ab6.reason, 'UNTRUSTED_SOURCE_BLOCK');
});

test('a failing recorder never breaks execution', () => {
  const broken = { runMutationOnce: () => { throw new Error('store down'); } };
  const result = runSandboxedWithEscapeRecording('(() => ({ ok: true }))()', {}, { sourceTrust: 'untrusted', graph: broken });
  assert.equal(result.ok, false);
  assert.equal(result.meta.ab6.decision, 'block');
});

test('the producer refuses to build without a runner', () => {
  assert.throws(() => createSandboxEscapeProducer({}), /requires a runSandboxed runner/);
  assert.throws(() => createSandboxEscapeProducer(), /requires a runSandboxed runner/);
});
