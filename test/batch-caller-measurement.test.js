'use strict';

/**
 * The measured claims in `docs/task-packs/p1k-batch-caller-measurement.md`.
 *
 * Two of them are negative results, and those are the ones worth pinning:
 *
 *   - the `warnings` channels P1-I proposed reusing are already owned by
 *     something else, so reusing them would conflate a provenance warning with
 *     an audit-evidence gap -- the exact distinction ADR-012 exists to keep;
 *   - the candidate ingest path, which holds six of the fourteen remaining
 *     sites, has no production entry, so there is no caller contract to derive
 *     its propagation shape from.
 *
 * A negative result decays as quietly as a positive one. If a production entry
 * for candidate ingest appears later, or a general warnings channel is added,
 * these tests fail and the document has to be revisited rather than trusted.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const Kernel = require('../kernel.js');

const REPO_ROOT = path.join(__dirname, '..');

function readCode(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function isolatedKernel() {
  return new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
}

/** An admitted, provenanced learn -- the shape that actually writes an edge. */
function admittedLearnOpts(n) {
  return {
    workspaceId: 'default',
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: `apr_${n}`,
    admissionRequired: true,
    provenance: {
      provenanceId: `prov-${n}`,
      sourceType: 'manual',
      sourceRef: `t:${n}`,
      actor: 'test',
      workspaceId: 'default',
      timestamp: '2026-06-29T00:00:00.000Z',
      trustPolicyVersion: '1.0.0',
    },
  };
}

/** Counts audit attempts, and optionally makes every one of them fail. */
function instrument(kernel, { dead = false } = {}) {
  const counter = { attempts: 0 };
  const real = kernel.graph.appendAuditEvent.bind(kernel.graph);
  kernel.graph.appendAuditEvent = (event, opts) => {
    counter.attempts += 1;
    if (dead) throw new Error('audit sink down');
    return real(event, opts);
  };
  return counter;
}

// --- answer 1: the warnings channel is not general --------------------------

test('the warnings channels are typed for something other than audit evidence', () => {
  // P1-I concluded no new abstraction is needed because three of four callers
  // already return a warnings channel. The channel exists; it is already owned.
  const conflict = readCode('lib/conflict-detector.js');
  const learnUseCase = readCode('lib/learn-use-case.js');

  // conflict-detector's warnings come from the candidate builder's validation.
  assert.match(conflict, /warnings: built\.warnings/);
  // learn's channel is named for provenance, and carries provenance policy
  // warnings -- putting an evidence gap here would say a failure to persist
  // evidence is a provenance warning.
  assert.match(learnUseCase, /provenanceWarnings/);
  assert.doesNotMatch(learnUseCase, /auditWarnings|evidenceWarnings|auditGaps/);
});

test('a learn result carries provenance warnings and no audit channel', () => {
  const kernel = isolatedKernel();

  const result = kernel.learn('kedi hayvandir', admittedLearnOpts(1));

  assert.ok(Array.isArray(result.data.provenanceWarnings));
  assert.equal('auditGaps' in result.data, false, 'no audit-evidence channel exists yet');
});

// --- answers 2 and 3: the failure is invisible, the write is preserved -------

test('a learn that really learns reports identically with a dead audit sink', () => {
  // P1-H could only measure this on a learn that extracted no facts, and said
  // so. This is the same comparison on an admitted write that lands an edge.
  const run = (dead) => {
    const kernel = isolatedKernel();
    const counter = instrument(kernel, { dead });
    const result = kernel.learn('kedi hayvandir', admittedLearnOpts(1));
    return {
      auditAttempts: counter.attempts,
      learned: result.data.learned,
      ok: result.ok,
      warnings: result.data.provenanceWarnings.length,
    };
  };

  const live = run(false);
  const dead = run(true);

  assert.equal(live.learned, 1, 'the fixture must actually learn, or this proves nothing');
  assert.equal(live.auditAttempts, 1);
  assert.deepEqual(dead, live, 'the audit failure must currently be invisible');
});

test('the committed edge survives its lost evidence', () => {
  // ADR-012: committed, not undone. Recorded so a later evidence change cannot
  // quietly start retracting the write instead of reporting the gap.
  const kernel = isolatedKernel();
  instrument(kernel, { dead: true });

  const result = kernel.learn('kedi hayvandir', admittedLearnOpts(1));

  assert.equal(result.ok, true);
  assert.equal(result.data.learned, 1);
  assert.ok(kernel.graph.getEdge('kedi', 'hayvan', 'tür', 'default'), 'the edge must be durable');
});

// --- answer 4: the multi-failure case did not reproduce ---------------------

test('a learn batch produces one audit write, across every sequence tried', () => {
  // The batch decision assumes a batch can produce several audit writes. For
  // this caller it did not, in any sequence constructed -- so accumulation is
  // over-engineering here.
  //
  // Asserted as `=== 1` rather than `<= 1` deliberately: if a learn ever starts
  // producing more, that is exactly the news this measurement lacked, and it
  // should surface as a failure rather than pass unnoticed.
  const kernel = isolatedKernel();
  const counter = instrument(kernel);
  const sequence = [
    'kedi hayvandir', 'kopek hayvandir', 'kedi memelidir',
    'kopek memelidir', 'kus hayvandir', 'kus ucar',
  ];

  sequence.forEach((text, index) => {
    counter.attempts = 0;
    kernel.learn(text, admittedLearnOpts(index));
    assert.equal(counter.attempts, 1, `"${text}" produced ${counter.attempts} audit writes`);
  });
});

// --- the finding that reorders the work -------------------------------------

test('the candidate ingest path has no production entry', () => {
  // Six of the fourteen remaining sites sit behind kernel.ingestCandidateClaim.
  // Nothing in production calls it: kernel.v2 forwards it, and the HTTP surface
  // only *reads* candidate claims.
  const server = readCode('server.js');

  assert.equal(server.includes('ingestCandidateClaim'), false, 'no HTTP ingest entry');
  assert.match(server, /queryCandidateClaims/, 'the HTTP surface reads candidate claims');
  assert.equal(readCode('cli.js').includes('ingestCandidateClaim'), false);
  assert.equal(readCode('mcpServer.js').includes('ingestCandidateClaim'), false);

  // kernel.v2's is a pass-through, not a second entry.
  assert.match(readCode('kernel.v2.js'), /ingestCandidateClaim\(input = \{\}, opts = \{\}\) \{\s*return this\.kernel\.ingestCandidateClaim\(input, opts\);/);

  // routeCandidateClaim's only other caller is classified not-yet-wired.
  const { NOT_YET_WIRED } = require('../lib/module-reachability.js');
  assert.ok(Object.prototype.hasOwnProperty.call(NOT_YET_WIRED, 'lib/github-connector.js'));
});

test('the learn path, by contrast, is production reachable', () => {
  // The contrast is the point: it is what makes the learn path the next unit
  // and the candidate path something to wait on.
  const { analyzeReachability } = require('../lib/module-reachability.js');
  const { reachable } = analyzeReachability();

  assert.ok(reachable.includes('lib/learn-use-case.js'));
  assert.ok(reachable.includes('lib/conflict-detector.js'));
});

test('_crossLink returns evidence that executeLearn still discards', () => {
  // The next unit, located: the first honest evidence a learn batch can carry
  // is already produced and thrown away. #906 is what made it trustworthy.
  const learnUseCase = readCode('lib/learn-use-case.js');

  assert.match(learnUseCase, /^\s*this\._crossLink\(subject, object, relation, workspaceId, \{/m);
  assert.doesNotMatch(learnUseCase, /=\s*this\._crossLink\(/, 'the return value is still discarded');
  // ...and the value on the other side is real.
  assert.match(readCode('kernel.js'), /return \{ written, audits, skipped \};/);
});
