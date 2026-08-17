'use strict';

/**
 * The measured claims in `docs/task-packs/p1i-evidence-aware-caller-map.md`.
 *
 * Two of them are load-bearing for what step 5 should be, and both are the
 * kind that a reading would get wrong:
 *
 *   - the fifteen discarding sites are five callers, not fifteen contracts;
 *   - `_crossLink`, cited as the precedent for counting evidence, over-reports
 *     it. That is demonstrated by running it against a dead audit sink, not
 *     argued from the source.
 *
 * The second is pinned deliberately as a *defect* test: it asserts the wrong
 * behaviour that exists today, so that fixing it fails here and the fix has to
 * come with its diff. It is not an endorsement.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

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

/** Two linked nodes sharing a tag, so `_crossLink` finds a derivation to make. */
function kernelWithCrossLinkableNodes(deadAudit) {
  const kernel = new Kernel({});
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

test('DEFECT: _crossLink counts an audit that was never written', () => {
  // The sharpest form of the evidence problem in this family, and different in
  // kind from the rest of it. Elsewhere a failed audit produces silence; here
  // it produces a false positive, which cannot be discovered by comparing
  // counts later because the count agrees with the wrong answer.
  //
  // Asserted as it is today so that the fix must land with its own diff.
  const live = crossLink(kernelWithCrossLinkableNodes(false));
  const dead = crossLink(kernelWithCrossLinkableNodes(true));

  assert.deepEqual(live, { written: 1, audits: 1, skipped: 0 });
  assert.deepEqual(dead, { written: 1, audits: 1, skipped: 0 });
  assert.equal(dead.audits, 1, 'today: one audit reported, zero written');

  // The write itself is correct either way -- the defect is in the reporting,
  // not in what reached the graph.
  assert.equal(dead.written, 1);
});

test('_crossLink contains the fix in its own other branch', () => {
  // The parent-allowed branch increments unconditionally; the background branch
  // guards on the result. Same counter, same loop, two different contracts.
  const source = readCode('kernel.js');

  assert.match(source, /this\._appendAuditEvent\(\{[\s\S]{0,700}?\}, parentProvenance, workspaceId\);\s*audits\+\+;/);
  assert.match(source, /if \(result\.audit\) audits\+\+;/);
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

  assert.deepEqual(new Set(enclosing('kernel.js', [796, 912])), new Set(['learn', '_crossLink']));
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
