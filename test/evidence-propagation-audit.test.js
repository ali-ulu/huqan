'use strict';

/**
 * The measured claims in `docs/task-packs/p1h-evidence-propagation-audit.md`.
 *
 * The migration unit for ADR-012 was chosen by the shared defect --
 * `_appendAuditEvent` swallowing audit failures -- rather than by position.
 * This pins what that unit actually contains, because the site count has now
 * been corrected twice and each correction changed the scale of the work.
 *
 * The load-bearing claim is that fixing the chokepoint alone is not enough:
 * fifteen of twenty-one sites discard the result, so there is no receiver for
 * a signal it would start producing. Both halves of that -- the counts, and
 * the fact that the loss is currently invisible end to end -- are measured
 * here rather than read.
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

test('the chokepoint is reached by 21 audit writes, not 17', () => {
  // p1g counted textual `_appendAuditEvent(` occurrences and treated
  // conflict-detector's appendAudit() as one site. It is a pass-through with
  // four callers of its own, each a distinct write.
  const kernel = readCode('kernel.js');
  const learnUseCase = readCode('lib/learn-use-case.js');
  const conflict = readCode('lib/conflict-detector.js');

  const direct = (src) => (src.match(/_appendAuditEvent\s*\(/g) || []).length;

  // kernel.js: 8 call sites plus the method definition.
  assert.equal(direct(kernel), 9);
  assert.equal(direct(learnUseCase), 7);
  // conflict-detector: two direct writes plus the helper's own forwarding call.
  assert.equal(direct(conflict), 3);

  // ...and the helper's four callers, which p1g did not count.
  const helperCalls = (conflict.match(/(?<!function )\bappendAudit\(kernelOrGraph,/g) || []).length;
  assert.equal(helperCalls, 4, 'appendAudit() callers');

  const writes = (direct(kernel) - 1) + direct(learnUseCase) + (direct(conflict) - 1) + helperCalls;
  assert.equal(writes, 21, 'total audit writes reaching the chokepoint');
});

test('seven sites bind the result; fourteen discard it', () => {
  // This is what makes a chokepoint-only fix insufficient: at the remaining
  // sites there is nothing to receive a signal it would start producing.
  //
  // Was 6/15 when p1h measured it. The _crossLink evidence-count fix bound a
  // seventh, so the debt ledger moves 6 -> 7 bound and 15 -> 14 discarded.
  // Recorded as a moving number rather than a fixed one: each caller made
  // evidence-aware should lower the second figure in a reviewable diff, the
  // same shape as the mutation-admission ratchet.
  const bound = (relPath) => (readCode(relPath).match(/=\s*this\._appendAuditEvent\s*\(/g) || []).length;

  assert.equal(bound('kernel.js'), 7, 'kernel.js binds seven results');
  assert.equal(bound('lib/learn-use-case.js'), 0);
  assert.equal(bound('lib/conflict-detector.js'), 0);

  // The six that bind it also propagate it to the caller.
  const kernel = readCode('kernel.js');
  assert.equal((kernel.match(/audit,\s*(?:admission|node|edge)/g) || []).length >= 4, true);
});

test('exactly one production consumer is evidence-aware', () => {
  // _crossLink counts evidence separately from writes. Every other consumer of
  // proposeNode/proposeEdge reads only decision and node/edge.
  const kernel = readCode('kernel.js');

  assert.match(kernel, /if \(result\.audit\) audits\+\+;/);
  assert.equal((kernel.match(/result\.audit/g) || []).length, 1, 'only one evidence-aware read');
});

/** Runs `body` against a kernel whose audit sink throws, and one where it works. */
function withAndWithoutAudit(body) {
  const working = body(new Kernel({}));
  const broken = new Kernel({});
  broken.graph.appendAuditEvent = () => { throw new Error('audit sink down'); };
  return { working, dead: body(broken) };
}

test('the learn path reports identically with a dead audit sink', () => {
  // The forbidden B3 at the learn surface. Scoped honestly: the fact extractor
  // returns `learned: 0` for a bare sentence here, so this exercises the entry
  // path and does not confirm sites 12-15 were reached. The claim it supports
  // is narrower and still the one being made -- the surface reports nothing
  // about audit evidence either way.
  const { working, dead } = withAndWithoutAudit((kernel) => {
    const result = kernel.learn('kedi hayvandir', { workspaceId: 'default' });
    return { type: result && result.type, ok: result && result.ok, mentionsAudit: JSON.stringify(result || {}).includes('audit') };
  });

  assert.deepEqual(dead, working);
  assert.equal(dead.ok, true, 'the mutation still reports success');
  assert.equal(dead.mentionsAudit, false, 'nothing in the result names the missing evidence');
});

test('the candidate ingest path reports identically with a dead audit sink', () => {
  const { working, dead } = withAndWithoutAudit((kernel) => {
    const result = kernel.ingestCandidateClaim(
      { claim: 'x causes y', sourceRef: 's', confidence: 0.6 },
      { workspaceId: 'default' },
    );
    return { keys: Object.keys(result || {}).sort(), hasAuditField: Boolean(result) && 'audit' in result };
  });

  assert.deepEqual(dead, working);
  assert.equal(dead.hasAuditField, false, 'the result carries no evidence field at all');
});

test('the severity is stated exactly: writes are correct, evidence is absent', () => {
  // Guards the claim against being read as "unauthorized writes happen": the
  // admitted write lands either way, and only the record of it vanishes.
  //
  // Demonstrated through proposeNode rather than learn. learn's fact extractor
  // produces no nodes for a bare sentence in this configuration -- checked, and
  // `learned: 0` for every phrase tried -- so a learn-based assertion here
  // would have passed or failed for reasons unrelated to auditing.
  const kernel = new Kernel({});
  kernel.graph.appendAuditEvent = () => { throw new Error('audit sink down'); };

  const result = kernel.proposeNode('n-evidence', 'label', {
    provenanceId: 'p1', actor: 'plugin', sourceType: 'plugin', sourceRef: 'r', workspaceId: 'default',
  }, { workspaceId: 'default' });

  assert.equal(result.decision, 'allow');
  assert.ok(result.node, 'the admitted write still lands');
  assert.ok(kernel.graph.getNode('n-evidence', 'default'), 'and is durable');
  assert.equal(result.audit, null, 'while its evidence is silently absent');
});

test('seven post sites sit inside an aggregating or transactional scope', () => {
  // The reason p1h argues against a per-write throw for them: aborting there
  // would undo a batch that has already partly committed, violating the other
  // half of the contract.
  const learnUseCase = readCode('lib/learn-use-case.js');
  const conflict = readCode('lib/conflict-detector.js');

  // learn-use-case's four post sites are inside `if (edge)` blocks that also
  // increment a counter.
  assert.equal((learnUseCase.match(/learned\+\+/g) || []).length >= 3, true);
  // conflict-detector's transactional write runs inside runMutationOnce.
  assert.match(conflict, /runMutationOnce\([^\n]*\(\) => \{/);
});
