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

test('the 19 audit writes are split across private Kernel and public Graph boundaries (#2166)', () => {
  const kernel = readCode('kernel.js');
  const learnUseCase = readCode('lib/learn-use-case.js');
  const conflict = readCode('lib/conflict-detector.js');

  const direct = (src) => (src.match(/_appendAuditEvent\s*\(/g) || []).length;
  // #2127: cross-link (dilim 1) moved one chokepoint call and proposeNode
  // (dilim 2) three more behind the injected alias (K2 shape); each facade
  // arrow repays one textual occurrence. learn-use-case is untouched.
  assert.equal(direct(kernel), 5, 'two facade arrows plus two direct calls plus the method definition');
  assert.equal(direct(learnUseCase), 7);
  assert.equal(direct(conflict), 0, 'conflict detection must not reach the private Kernel audit seam');

  const helperCalls = (conflict.match(/(?<!function )\bappendAudit\(/g) || []).length;
  assert.equal(helperCalls, 6, 'conflict detector public Graph audit writes');

  const privateWrites = (direct(kernel) - 1) + direct(learnUseCase);
  assert.equal(privateWrites, 11, 'remaining writes through the private Kernel compatibility chokepoint');
  assert.equal(privateWrites + helperCalls, 17, 'total audit writes remain unchanged');
});

test('kernel binding sites move out with their bodies; eleven discard it', () => {
  // This is what makes a chokepoint-only fix insufficient: at the remaining
  // sites there is nothing to receive a signal it would start producing.
  //
  // Was 6/15 when p1h measured it. The _crossLink evidence-count fix bound a
  // seventh, so the debt ledger moves 6 -> 7 bound and 15 -> 14 discarded.
  // Recorded as a moving number rather than a fixed one: each caller made
  // evidence-aware should lower the second figure in a reviewable diff, the
  // same shape as the mutation-admission ratchet.
  //
  // K2 (#328): the background-edge commit delegation moved three of the
  // kernel's result-binding sites to lib/background-provenance.js.
  // #2127: _crossLink's site moved to lib/kernel-cross-link.js (dilim 1)
  // and proposeNode's three sites to lib/kernel-propose-node.js (dilim 2).
  // Kernel keeps none; the modules bind one and three respectively.
  const bound = (relPath) => (readCode(relPath).match(/=\s*this\._appendAuditEvent\s*\(/g) || []).length;

  assert.equal(bound('kernel.js'), 0, 'kernel.js binds no results directly anymore (K2 + #2127 delegated)');
  const moduleBound = (relPath) => (readCode(relPath).match(/=\s*appendAuditEvent\s*\(/g) || []).length;
  assert.equal(moduleBound('lib/kernel-cross-link.js'), 1, 'cross-link module binds its audit result');
  assert.equal(moduleBound('lib/kernel-propose-node.js'), 3, 'propose-node module binds its three audit results');
  assert.equal(bound('lib/learn-use-case.js'), 0);
  assert.equal(bound('lib/conflict-detector.js'), 0);

  // The binding sites propagate it to the caller. K2 (#328): the background
  // edge commit delegation moved one propagation site to
  // lib/background-provenance.js, so the kernel floor is now 3.
  // #2127: cross-link (dilim 1) and proposeNode (dilim 2) moved the rest;
  // the floor now lives in lib/kernel-propose-node.js, kernel.js keeps
  // only the delegation.
  const kernel = readCode('kernel.js');
  assert.equal((kernel.match(/audit,\s*(?:admission|node|edge)/g) || []).length, 0, 'no propagation site left inline');
  const proposeNode = readCode('lib/kernel-propose-node.js');
  assert.equal((proposeNode.match(/audit,\s*(?:admission|node|edge)/g) || []).length, 3, 'proposeNode returns propagate audit+admission');
  assert.match(kernel, /return runProposeNode\(\{ graph: this\.graph,/);
});

test('exactly one production consumer is evidence-aware', () => {
  // _crossLink counts evidence separately from writes. Every other consumer of
  // proposeNode/proposeEdge reads only decision and node/edge.
  // #2127: the read moved with the body to lib/kernel-cross-link.js.
  const crossLink = readCode('lib/kernel-cross-link.js');

  assert.match(crossLink, /if \(result\.audit\) audits\+\+;/);
  assert.equal((crossLink.match(/result\.audit/g) || []).length, 1, 'only one evidence-aware read');
  assert.match(readCode('kernel.js'), /return runCrossLink\(\{ graph: this\.graph,/);
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
