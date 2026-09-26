const Kernel = require('./kernel');
const { runPreIngest } = require('./lib/pre-ingest');
const { normalizePredicateToken: evidenceNormalizePredicateToken } = require('./lib/kernel-v2-evidence');
const { runVerify } = require('./lib/kernel-v2-verify');
const { runContradictionDetails, findOppositePredicateConflict } = require('./lib/kernel-v2-contradiction');

// Mechanical 1:1 extraction (#328, docs/kernel-split-plan.md V2-A): pure native
// helpers, the opposite-predicate seed table, and the manipulation rule
// table moved to lib/kernel-v2-native.js. Behaviour is unchanged -- the
// module-init seed still runs when kernel-v2-native is first required,
// which is exactly when KernelV2 itself is required.
const { nowIso } = require('./lib/kernel-v2-native');
const {
  prepareRiskAwareLearnFromLLM,
  withLearnFromLLMRisk,
} = require('./lib/text-safety-scorer');

class KernelV2 {
  constructor(opts = {}) {
    // #329: now that KernelV2 is the canonical runtime, an already-canonical
    // kernel is what callers have on hand, so `opts.kernel` may well be a
    // KernelV2. Unwrap it instead of falling through to `new Kernel(opts)` --
    // that fallback would silently discard the caller's kernel and build a
    // second, empty one, which is exactly the kind of quiet substitution this
    // issue is about.
    if (opts.kernel instanceof Kernel) this.kernel = opts.kernel;
    else if (opts.kernel instanceof KernelV2) this.kernel = opts.kernel.kernel;
    else this.kernel = new Kernel(opts);
  }

  get plugins() {
    return this.kernel.plugins;
  }
  get graph() {
    return this.kernel.graph;
  }

  // #329: server.js's graph-data endpoint reads kernel.memory.list() and
  // kernel.memory.queryLinks() behind a `kernel.memory && ...` guard. Before
  // KernelV2 became the canonical runtime that guard simply never saw a v2
  // kernel; afterwards it would have failed silently, reporting
  // "kernel.memory unavailable" instead of the workspace's memory entries.
  get memory() {
    return this.kernel.memory;
  }
  get contractVersion() {
    return this.kernel.contractVersion;
  }
  ok(type, data = null, evidence = [], meta = {}) {
    if (typeof this.kernel.ok === 'function') {
      return this.kernel.ok(type, data, evidence, meta);
    }
    return {
      ok: true,
      type,
      data,
      evidence: Array.isArray(evidence) ? evidence : [],
      error: null,
      meta,
    };
  }

  fail(type, code, message, meta = {}) {
    if (typeof this.kernel.fail === 'function') {
      return this.kernel.fail(type, code, message, meta);
    }
    return {
      ok: false,
      type,
      data: null,
      evidence: [],
      error: { code, message },
      meta,
    };
  }

  learn(text, opts = {}) {
    const source = opts.source || 'user';
    const learnedAt = opts.learnedAt || nowIso();
    const beforeEdgeMap = this.kernel.graph.captureTemporalEdgeKeys();
    const result = this.kernel.learn(text, opts);
    // #733: workspace-scoped, on top of the touch scope narrowing to written edges.
    this.kernel.graph.applyTemporalEdgeMetadata(source, learnedAt, beforeEdgeMap, { workspaceId: opts.workspaceId });
    return this.ok('learn', result.data, result.evidence, { ...result.meta, source, learnedAt });
  }

  learnDocument(text, opts = {}) {
    return this.kernel.learnDocument(text, opts);
  }

  learnFromLLM(text, opts = {}) {
    if (this.kernel.paranoidMode) {
      return this.kernel.learnFromLLM(text, opts);
    }

    const riskAssessment = prepareRiskAwareLearnFromLLM(text, opts);
    const result = this.kernel.learnFromLLM(riskAssessment.text, {
      ...opts,
      skipConflicts: opts.skipConflicts !== false,
    });
    return withLearnFromLLMRisk(result, riskAssessment);
  }

  ask(question, opts = {}) {
    const result = this.kernel.ask(question, opts);
    return this.ok('ask', result.data, result.evidence, {
      ...result.meta,
      mode: 'v2',
    });
  }

  // Guarded: bare spelling collapsed `kültür` onto `kül`, verifying a false claim at 0.95 (#1167).
  normalizePredicateToken(predicate) {
    return evidenceNormalizePredicateToken(predicate);
  }

  // The candidate-claim family stays on this file: the mutation-admission
  // contracts count these delegations here, and each forwards to the
  // admitted kernel path unchanged.
  addCandidateClaim(candidate, opts = {}) {
    return this.kernel.addCandidateClaim(candidate, opts);
  }

  getCandidateClaims(filters = {}) {
    return this.kernel.getCandidateClaims(filters);
  }

  detectClaimConflict(claim, opts = {}) {
    return this.kernel.detectClaimConflict(claim, opts);
  }

  ingestCandidateClaim(input = {}, opts = {}) {
    return this.kernel.ingestCandidateClaim(input, opts);
  }

  _findOppositePredicateConflict(subject, normalizedTargetToken, maxDepth = 4, workspaceId = 'default') {
    return findOppositePredicateConflict({ v2: this, graph: this.kernel.graph, collectPredicateTargets: (...args) => this._collectPredicateTargets(...args), collectTypeTargets: (...args) => this._collectTypeTargets(...args), inferTypeChain: (...args) => this._inferTypeChain(...args), buildPredicateEvidence: (...args) => this._buildPredicateEvidence(...args), directTypeEvidence: (...args) => this.buildDirectTypeEvidence(...args) }, subject, normalizedTargetToken, maxDepth, workspaceId);
  }

  _buildContradictionDetails(parsed, normalizedTarget, normalizedTargetToken, opts = {}) {
    return runContradictionDetails({ v2: this, graph: this.kernel.graph, collectPredicateTargets: (...args) => this._collectPredicateTargets(...args), collectTypeTargets: (...args) => this._collectTypeTargets(...args), inferTypeChain: (...args) => this._inferTypeChain(...args), buildPredicateEvidence: (...args) => this._buildPredicateEvidence(...args), directTypeEvidence: (...args) => this.buildDirectTypeEvidence(...args) }, parsed, normalizedTarget, normalizedTargetToken, opts);
  }

  verify(statement, opts = {}) {
    return runVerify({ v2: this, kernel: this.kernel, verifyBase: (...args) => this.kernel.verify(...args), ok: (...args) => this.ok(...args), withVerifyDetails: (...args) => this._withVerifyDetails(...args), buildContradictionDetails: (...args) => this._buildContradictionDetails(...args) }, statement, opts);
  }

  reason(subject, opts = {}) {
    const result = this.kernel.reason(subject, opts);
    return this.ok('reason', result.data, result.evidence, {
      ...result.meta,
      mode: 'v2',
    });
  }

  compare(left, right, opts = {}) {
    const result = this.kernel.compare(left, right, opts);
    return this.ok('compare', result.data, result.evidence, {
      ...result.meta,
      mode: 'v2',
    });
  }

  dream(opts = {}) {
    const result = this.kernel.dream(opts);
    return this.ok('dream', result.data, result.evidence, {
      ...result.meta,
      mode: 'v2',
    });
  }

  // The async pair cannot be delegated the same way. Kernel.learnAsync() runs
  // the preIngest pass and then calls its own learn(), which under delegation
  // would be the wrapped v1 learn() -- silently dropping the temporal edge
  // metadata and the v2 result envelope that this.learn() adds. Same for
  // verifyAsync() and the manipulation-risk/type-chain evidence in
  // this.verify(). Both therefore run the v1 pre-pass and then re-enter the
  // v2 method, so the async and sync paths agree under v2.
  async learnAsync(text, opts = {}) {
    const prepared = await runPreIngest(this.plugins, text, opts);
    return this.learn(prepared.text, prepared.opts || opts);
  }

  async verifyAsync(statement, opts = {}) {
    return this.verify(statement, opts);
  }
}

// Plain forwarders and the evidence/explanation helpers live in their own
// modules and are installed as ordinary (non-enumerable) methods (#2138).
require('./lib/kernel-v2-forwarding').install(KernelV2);
require('./lib/kernel-v2-evidence-methods').install(KernelV2);

module.exports = KernelV2;
