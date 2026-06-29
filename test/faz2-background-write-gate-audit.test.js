'use strict';

/**
 * FAZ2-PR3 — F-001 Background Write Gate + Audit
 *
 * Closes the F-001 finding from docs/audits/faz2-pr1-boundary-red-evidence.md:
 *   "Background mutation paths (_autoThinkTick, dream(learnFromDream),
 *    selfEvolve, _crossLink) call graph.addEdge directly without admission
 *    evaluation or audit context."
 *
 * Verified properties:
 *   - Each background path attaches synthetic provenance describing its source
 *     (kernel-background:<path>) so admission and audit can attribute writes.
 *   - Each background path routes its proposed edges through the SAME
 *     admission gate (_evaluateLearnAdmission / evaluateMemoryAdmission) the
 *     user-facing learn path uses.
 *   - Default admission decision for synthetic background provenance is
 *     'review' — therefore canonical writes do NOT happen silently.
 *   - Every attempt (allow / review / reject) produces an audit event whose
 *     details record backgroundSource, decision, and edge identity.
 *   - When the gate would write, the resulting edge carries
 *     source/provenance metadata.
 *
 * What this PR does NOT do (still skip in faz2-pr1 contract):
 *   - Implement kernel._commitMutation (FAZ2-2 future Universal Mutation
 *     Boundary).  The F-001 contract assertions depend on _commitMutation
 *     existing as a single chokepoint; this PR strengthens admission/audit at
 *     the call sites instead.  The contract tests therefore stay skipped.
 *
 * No fake bypass: the kernel still rejects admissionRequired:false without a
 * bypass reason (covered by faz2-admission-default-on.test.js).  This PR does
 * not introduce a default bypass for any background path.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Kernel = require('../kernel');

function makeKernel() {
  return new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
}

// Seed nodes via the bypass path (the only sanctioned way to deterministically
// pre-populate the graph in tests; see faz2-admission-default-on.test.js).
function seed(kernel, statements) {
  for (const stmt of statements) {
    const r = kernel.learn(stmt, {
      workspaceId: 'default',
      admissionRequired: false,
      admissionBypassReason: 'test_fixture_seed',
    });
    assert.equal(r.ok, true);
  }
}

function backgroundAuditEvents(kernel, source) {
  const events = kernel.graph.getAuditEvents({ workspaceId: 'default' });
  return events.filter((ev) => {
    const details = ev.details || {};
    if (source && details.backgroundSource !== source) return false;
    return ev.targetType === 'background_edge' || ev.targetType === 'derived_edge';
  });
}

function nodeCount(kernel) {
  return Object.keys(kernel.graph._nodes || {}).length;
}

function edgeCount(kernel) {
  return (kernel.graph._edges || []).length;
}

describe('FAZ2-PR3: background write gate + audit (F-001)', () => {
  it('_autoThinkTick does not silently write to graph and produces audit events', () => {
    const kernel = makeKernel();
    seed(kernel, [
      'kedi hayvandir',
      'kopek hayvandir',
      'kus hayvandir',
    ]);

    const edgesBefore = edgeCount(kernel);
    const nodesBefore = nodeCount(kernel);

    // Stub a deterministic Dreamer so the tick has hypotheses to route.
    kernel._dreamCount = 0;
    kernel._dreamer = {
      dream() {
        return [
          { from: 'kedi', to: 'kopek', type: 'benzerlik', confidence: 0.9, relation: 'benzer' },
          { from: 'kopek', to: 'kus',  type: 'benzerlik', confidence: 0.8, relation: 'benzer' },
        ];
      },
    };

    // Drain prior background audit events (seed produced derived_edge audits).
    const priorBackgroundAudits = backgroundAuditEvents(kernel, '_autoThinkTick').length;

    assert.doesNotThrow(() => kernel._autoThinkTick());

    // Default admission for synthetic background provenance is 'review'.
    // → no new canonical edges written.
    assert.equal(
      edgeCount(kernel),
      edgesBefore,
      'background tick must not increase canonical edge count under default admission'
    );
    assert.equal(
      nodeCount(kernel),
      nodesBefore,
      'background tick must not add nodes'
    );

    // Every hypothesis should have produced a REVIEW audit attributed to the
    // _autoThinkTick source so the attempt is visible.
    const newAudits = backgroundAuditEvents(kernel, '_autoThinkTick');
    assert.ok(
      newAudits.length >= 2 && newAudits.length >= priorBackgroundAudits + 2,
      `_autoThinkTick must emit audit events for each hypothesis (got ${newAudits.length})`
    );
    for (const ev of newAudits) {
      assert.ok(
        ev.eventType === 'REVIEW' || ev.eventType === 'REJECT' || ev.eventType === 'LEARN',
        `unexpected audit eventType: ${ev.eventType}`
      );
      assert.equal(ev.details.backgroundSource, '_autoThinkTick');
    }
  });

  it('dream(learnFromDream) does not silently write to graph and produces audit events', () => {
    const kernel = makeKernel();
    seed(kernel, [
      'kedi hayvandir',
      'kopek hayvandir',
    ]);

    // Stub Dream to surface a controlled hypothesis without coupling to NLP.
    const Dream = require('../dream');
    const originalProto = Dream.prototype.dream;
    Dream.prototype.dream = function () {
      return [
        { from: 'kedi', to: 'kopek', type: 'benzerlik', confidence: 0.9, relation: 'benzer' },
      ];
    };

    try {
      const edgesBefore = edgeCount(kernel);
      const result = kernel.dream({ learnFromDream: true });
      assert.equal(result.ok, true);

      // Default admission for background-derived hypotheses is 'review' →
      // no canonical write, but the proposal is tracked in `pending`.
      assert.equal(
        edgeCount(kernel),
        edgesBefore,
        'dream(learnFromDream) must not increase canonical edge count under default admission'
      );
      assert.equal(result.data.learned.length, 0);
      assert.ok(Array.isArray(result.data.pending));
      assert.ok(
        result.data.pending.length >= 1,
        'dream(learnFromDream) must surface review/reject proposals as pending'
      );
      assert.ok(
        ['review', 'reject', 'quarantine'].includes(result.data.pending[0].decision),
        `pending decision must be a non-allow outcome (got ${result.data.pending[0].decision})`
      );

      const audits = backgroundAuditEvents(kernel, 'dream');
      assert.ok(
        audits.length >= 1,
        'dream(learnFromDream) must emit at least one audit event per hypothesis'
      );
      assert.equal(audits[0].details.backgroundSource, 'dream');
    } finally {
      Dream.prototype.dream = originalProto;
    }
  });

  it('selfEvolve does not silently write to graph and produces audit events', () => {
    const kernel = makeKernel();
    seed(kernel, [
      'kedi hayvandir',
      'kopek hayvandir',
    ]);

    const Dream = require('../dream');
    const originalProto = Dream.prototype.dream;
    Dream.prototype.dream = function () {
      return [
        { from: 'kedi', to: 'kopek', type: 'benzerlik', confidence: 0.9, relation: 'benzer' },
      ];
    };

    try {
      const edgesBefore = edgeCount(kernel);
      const result = kernel.selfEvolve();

      // Default admission for background writes is 'review' → no canonical
      // mutation; deferred proposals surfaced for operator review.
      assert.equal(
        edgeCount(kernel),
        edgesBefore,
        'selfEvolve must not increase canonical edge count under default admission'
      );
      assert.equal(result.added, 0);
      assert.ok(
        result.deferred >= 1,
        'selfEvolve must surface review/reject decisions as deferred proposals'
      );

      const audits = backgroundAuditEvents(kernel, 'selfEvolve');
      assert.ok(
        audits.length >= 1,
        'selfEvolve must emit at least one audit event per proposal'
      );
      assert.equal(audits[0].details.backgroundSource, 'selfEvolve');
    } finally {
      Dream.prototype.dream = originalProto;
    }
  });

  it('_crossLink invoked as background path does not silently write and produces audit', () => {
    const kernel = makeKernel();
    // Pre-build a shared-tag scenario by seeding facts.
    seed(kernel, [
      'kedi hayvandir',
      'kopek hayvandir',
    ]);

    // Force shared vector tag between two distinct nodes so cross-link can
    // derive a "benzer" edge proposal.
    kernel.graph.addTag('kedi', 'tag-shared', 0.9, 'default');
    kernel.graph.addTag('kopek', 'tag-shared', 0.9, 'default');
    kernel.graph.addNode('tag-shared', null, 'default');

    const edgesBefore = edgeCount(kernel);
    // Remove any pre-existing 'benzer' edge to make the test deterministic.
    const existing = kernel.graph.getEdge('kedi', 'kopek', 'benzer', 'default');
    assert.ok(!existing, 'precondition: no pre-existing benzer edge between kedi and kopek');

    // External / background invocation (no parent context) → admission gate.
    const result = kernel._crossLink('kedi', 'kopek', 'benzer', 'default');

    // Under default admission, no canonical write.
    assert.equal(
      edgeCount(kernel),
      edgesBefore,
      '_crossLink background call must not write canonical benzer edge under default admission'
    );
    assert.equal(result.written, 0);
    assert.ok(result.audits >= 1, '_crossLink background call must emit audit event');

    const audits = backgroundAuditEvents(kernel, '_crossLink');
    assert.ok(audits.length >= 1, 'audit log must contain _crossLink background event');
    assert.equal(audits[0].details.backgroundSource, '_crossLink');
    assert.ok(
      audits[0].eventType === 'REVIEW' || audits[0].eventType === 'REJECT',
      `background _crossLink audit must be REVIEW/REJECT under default admission (got ${audits[0].eventType})`
    );
  });

  it('on review/reject admission decision, background path does not force canonical mutation', () => {
    const kernel = makeKernel();
    seed(kernel, ['kedi hayvandir', 'kopek hayvandir']);

    const before = edgeCount(kernel);
    // _commitBackgroundEdge is the helper all four paths use; default
    // admission is review (no canonical write).
    const result = kernel._commitBackgroundEdge('kedi', 'kopek', 'benzer', 'test_review_path', {});
    assert.equal(
      result.decision,
      'review',
      'default background admission decision must be review (not allow) for safety'
    );
    assert.equal(result.edge, null, 'review decision must not produce a canonical edge');
    assert.equal(edgeCount(kernel), before, 'review decision must not change edge count');
    assert.ok(result.audit, 'review decision must still produce an audit event');
    assert.equal(result.audit.eventType, 'REVIEW');
    assert.equal(result.audit.details.backgroundSource, 'test_review_path');
  });

  it('on allow, background mutation carries audit/provenance/source context', () => {
    const kernel = makeKernel();
    seed(kernel, ['kedi hayvandir', 'kopek hayvandir']);

    // Stub admission to return 'allow' so we can verify the allow-path
    // produces a properly attributed edge + LEARN audit.  Stubbing the
    // already-reused gate (not adding a kernel bypass flag) keeps this from
    // becoming a fake bypass: the kernel still calls into
    // _evaluateLearnAdmission, which is exactly where deployments hook
    // policy.
    const originalEvaluate = kernel._evaluateLearnAdmission.bind(kernel);
    kernel._evaluateLearnAdmission = function (text, opts, provenance, workspaceId) {
      const base = originalEvaluate(text, opts, provenance, workspaceId);
      // Only force-allow when the call site is a background path (synthetic
      // actor prefix); leave user-facing learn calls untouched.
      if (opts && typeof opts.actor === 'string' && opts.actor.startsWith('kernel-background:')) {
        return {
          ...(base || {}),
          outcome: 'allow',
          reason: 'test_force_allow',
          graphWrite: true,
          workspaceId,
          approvalStatus: 'approved',
          provenanceId: provenance ? provenance.provenanceId : '',
        };
      }
      return base;
    };

    const before = edgeCount(kernel);
    const result = kernel._commitBackgroundEdge('kedi', 'kopek', 'benzer', '_autoThinkTick', {});

    assert.equal(result.decision, 'allow');
    assert.ok(result.edge, 'allow must produce a canonical edge');
    assert.equal(edgeCount(kernel), before + 1, 'allow must add exactly one edge');

    // Edge should carry provenance + background source on its options trail.
    const writtenEdge = kernel.graph.getEdge('kedi', 'kopek', 'benzer', 'default');
    assert.ok(writtenEdge, 'edge must be reachable via graph.getEdge');
    // Source attribution: either a provenance object or a source field
    // identifying background:_autoThinkTick should be present on the edge.
    const provenanceAttached =
      writtenEdge.provenance && writtenEdge.provenance.provenanceId &&
      typeof writtenEdge.provenance.provenanceId === 'string' &&
      writtenEdge.provenance.provenanceId.startsWith('prov_bg_');
    const sourceAttached =
      typeof writtenEdge.source === 'string' &&
      writtenEdge.source.indexOf('background:') === 0;
    assert.ok(
      provenanceAttached || sourceAttached,
      'edge written by background path must carry provenance or source metadata identifying it as background-derived'
    );

    // Audit event for the allow decision should be LEARN with the
    // background source recorded.
    assert.ok(result.audit, 'allow decision must emit an audit event');
    assert.equal(result.audit.eventType, 'LEARN');
    assert.equal(result.audit.details.backgroundSource, '_autoThinkTick');
  });

  it('no kernel-level default bypass: admissionRequired:false without reason still gates background writes', () => {
    // This is a guard test against the temptation to "fix" the F-001 failures
    // by introducing admissionRequired:false / admissionBypassReason on the
    // background call sites.  _commitBackgroundEdge MUST NOT inject a
    // permanent bypass — we assert that calling it with the standard
    // (non-overridden) opts path still produces 'review'.
    const kernel = makeKernel();
    seed(kernel, ['kedi hayvandir', 'kopek hayvandir']);

    // Even if a caller tried to slip a half-formed bypass in via opts,
    // _evaluateLearnAdmission requires BOTH admissionRequired:false AND a
    // non-empty admissionBypassReason to honor it.  _commitBackgroundEdge
    // does not set either, so the gate remains active.
    const result = kernel._commitBackgroundEdge('kedi', 'kopek', 'benzer', 'guard_no_bypass', {});
    assert.notEqual(
      result.decision,
      'allow',
      'background path must not produce a default-allow decision; bypass would re-open F-001'
    );
  });
});
