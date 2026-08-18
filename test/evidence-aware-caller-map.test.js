'use strict';

/**
 * The measured claims in `docs/task-packs/p1i-evidence-aware-caller-map.md`.
 *
 * Two of them are load-bearing for what step 5 should be, and both are the
 * kind that a reading would get wrong:
 *
 *   - the fifteen discarding sites are five callers, not fifteen contracts;
 *   - `_crossLink`, cited as the precedent for counting evidence, over-reported
 *     it. That was demonstrated by running it against a dead audit sink rather
 *     than argued from the source, and it is now **fixed**.
 *
 * The second was pinned as a *defect* test -- asserting the wrong behaviour so
 * the fix had to arrive with its own diff. This is that diff, so the assertion
 * is inverted rather than deleted: the counter is now checked to stay honest,
 * in the place that recorded it lying.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const os = require('node:os');

const Kernel = require('../kernel.js');

const REPO_ROOT = path.join(__dirname, '..');
const PROVENANCE = Object.freeze({
  provenanceId: 'p1', actor: 'plugin', sourceType: 'plugin', sourceRef: 'r', workspaceId: 'default',
});

function readCode(relPath) {
  return fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/**
 * Each kernel must get its own temp path: `new Kernel({})` lands every test
 * in the repository's default `memory.db`, so kernels share a SQLite file and
 * the measurements pick up state left behind by earlier subtests (and, on
 * parallel runs, by sibling files -- SQLITE_BUSY).
 */
function makeTempKernel() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-evidence-'));
  const kernel = new Kernel({ memoryPath: path.join(dir, 'm.json'), dbPath: path.join(dir, 'g.db') });
  kernel.__evidenceTempDir = dir;
  return kernel;
}

/** Two linked nodes sharing a tag, so `_crossLink` finds a derivation to make. */
function kernelWithCrossLinkableNodes(deadAudit) {
  const kernel = makeTempKernel();
  for (const id of ['tagx', 's', 'o']) kernel.proposeNode(id, id, PROVENANCE, { workspaceId: 'default' });
  kernel.graph.addTag('s', 'tagx', 0.9, 'default');
  kernel.graph.addTag('o', 'tagx', 0.9, 'default');
  if (deadAudit) kernel.graph.appendAuditEvent = () => { throw new Error('audit sink down'); };
  return kernel;
}

function crossLink(kernel) {
  return kernel._crossLink('s', 'o', 'benzer', 'default', {
    parentAdmissionAllowed: true, parentProvenance: PROVENANCE,
  });
}

test('_crossLink counts only the audits it actually wrote', () => {
  // Was a defect test asserting `audits: 1` with a dead sink. The fix inverts
  // it: the counter now reports zero evidence when zero evidence was produced.
  const live = crossLink(kernelWithCrossLinkableNodes(false));
  const dead = crossLink(kernelWithCrossLinkableNodes(true));

  assert.deepEqual(live, { written: 1, audits: 1, skipped: 0 });
  assert.deepEqual(dead, { written: 1, audits: 0, skipped: 0 });
});

test('the fix does not retract the write whose evidence was lost', () => {
  // ADR-012's post-mutation rule is "must not be undone, must not be hidden".
  // Making the counter honest must not tip into the other failure mode of
  // pretending the edge never landed -- so `written` stays 1 and the edge
  // stays in the graph.
  const kernel = kernelWithCrossLinkableNodes(true);

  const result = crossLink(kernel);

  assert.equal(result.written, 1);
  assert.equal(result.audits, 0);
  assert.ok(kernel.graph.getEdge('s', 'o', 'benzer', 'default'), 'the derived edge must remain durable');
});

test('the gap is now visible in the difference between the two counters', () => {
  // What "visible" means here, concretely: a caller comparing the counters can
  // tell that evidence is missing. Before the fix both read 1 and the gap was
  // undetectable from the return value.
  const dead = crossLink(kernelWithCrossLinkableNodes(true));

  assert.ok(dead.written > dead.audits, 'written must exceed audits when evidence was lost');
});

test('both _crossLink branches now guard the counter the same way', () => {
  // The two branches had different contracts for the same counter. They now
  // agree: each increments only on a produced audit event.
  const source = readCode('kernel.js');

  assert.match(source, /\}, parentProvenance, workspaceId\);\s*if \(audit\) audits\+\+;/);
  assert.match(source, /if \(result\.audit\) audits\+\+;/);
  // And the unconditional form is gone rather than merely shadowed.
  assert.doesNotMatch(source, /workspaceId\);\s*audits\+\+;/);
});

test('the fifteen discarding sites are five caller functions', () => {
  // Step 5's scope. Pinned because this is the one measurement in the sequence
  // that made the work smaller rather than larger, and a drift back would
  // silently re-expand it.
  const enclosing = (relPath, lines) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8').split('\n');
    return lines.map((line) => {
      for (let i = line - 1; i >= 0; i -= 1) {
        const match = source[i].match(/^(?:async )?function (\w+)|^ {2}(?:async )?(\w+)\(/);
        if (match) return match[1] || match[2];
      }
      return '?';
    });
  };

  // K2 (#328): the background-edge commit was delegated to
  // lib/background-provenance.js, so kernel.js line numbers shifted. The
  // learn discarding site is now line 694 (the ProvenanceError re-append),
  // and _crossLink's derivation site remains at 796.
  assert.deepEqual(new Set(enclosing('kernel.js', [796, 694])), new Set(['learn', '_crossLink']));
  assert.deepEqual(
    new Set(enclosing('lib/learn-use-case.js', [30, 49, 77, 233, 261, 293, 334])),
    new Set(['executeLearn']),
  );
  assert.deepEqual(
    new Set(enclosing('lib/conflict-detector.js', [412, 453])),
    new Set(['acceptCandidateClaimJournaled']),
  );
});

test('no accumulation seam exists; the nearest mechanism is HTTP-shaped', () => {
  // Step 4 said to use the smallest existing reconciliation mechanism before
  // adding an abstraction. The semantics are reusable; the shape is not.
  const { auditEvidenceGap } = require('../lib/workbench/ingest-approval-audit.js');

  const gap = auditEvidenceGap({
    approval: { id: 'a' }, receipt: { receiptId: 'r', decision: 'approved' },
    committed: true, reason: 'audit_append_failed', message: 'm',
  });

  // Reusable: the vocabulary and the rules.
  assert.equal(gap.json.error.code, 'AUDIT_EVIDENCE_MISSING');
  assert.equal(gap.json.reconciliation.retry, false);
  // Not reusable: it is a transport response keyed on approval and receipt,
  // and none of the four batch callers has either.
  assert.equal(gap.status, 409);
  assert.ok('json' in gap);
});

test('all four batch callers already return somewhere to report a gap', () => {
  // Why "one common accumulation mechanism" is not supported by the evidence:
  // each caller already has a field for this answer.
  const kernel = readCode('kernel.js');
  const conflict = readCode('lib/conflict-detector.js');
  const learnUseCase = readCode('lib/learn-use-case.js');

  assert.match(kernel, /return \{ written, audits, skipped \};/);
  assert.equal((conflict.match(/warnings: built\.warnings/g) || []).length >= 3, true);
  assert.match(learnUseCase, /provenanceWarnings/);
});
