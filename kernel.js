const Graph = require('./graph');
const Dream = require('./dream');
const fs = require('fs');
const path = require('path');
const PluginManager = require('./plugin');
const createNlp = require('./nlp');
const VerifyService = require('./lib/verify');
const { buildBackgroundProvenance, sponsorBackgroundProvenance, provenanceFieldsFrom, commitBackgroundEdge } = require('./lib/background-provenance');
const { evaluateLearnAdmission } = require('./lib/kernel-learn-admission');
const { createKernelReadUseCases } = require('./lib/kernel-read-use-cases');
const { runLearnUseCase } = require('./lib/learn-use-case');
const { runLearnTransaction } = require('./lib/kernel-learn-transaction');
const { runProposeNode } = require('./lib/kernel-propose-node');
const MemoryStore = require('./lib/memory-store'); const { siblingPersistencePath, hookGraphCloseForMemoryStore } = require('./lib/memory-store-utils');
const { buildCanonicalReceiptPayload } = require('./lib/receipt/canonical-receipt');
const { toCanonicalVerdict } = require('./lib/verdict/action-verdict');
const { readCompatibleEnvironmentVariable } = require('./lib/environment-compat');
const { runRustSandboxResult } = require('./lib/reason-sandbox');
const { install: installCapabilityMethods } = require('./lib/kernel-capability-methods');
const { install: installPrimitiveMethods } = require('./lib/kernel-primitive-methods');
const { install: installReadMethods } = require('./lib/kernel-read-methods');
const { install: installPersistenceMethods } = require('./lib/kernel-persistence-methods');
const { install: installLearnInputMethods } = require('./lib/kernel-learn-input-methods');
const { install: installCognitionMethods } = require('./lib/kernel-cognition-methods');

let RustGraph;
try { RustGraph = require('./rustGraph'); } catch {}
const RUST_BIN = RustGraph && RustGraph.resolveRustBin ? RustGraph.resolveRustBin() : readCompatibleEnvironmentVariable('RUST_BIN');
const hasRust = !!RUST_BIN && fs.existsSync(RUST_BIN) && typeof RustGraph !== 'undefined';

// Canonical receipt projection for a committed learn mutation. Kept here
// (rather than in lib/kernel-learn-transaction.js) because the receipt and
// verdict modules live in the Application layer while that module is Core:
// a direct require would be a new Core -> Application layer violation, and
// the layer contract prefers an injected seam over a new exception. The
// transaction receives this as buildCanonicalReceipt.
function buildLearnCanonicalReceipt(receipt, operationId, committedAt) {
  return buildCanonicalReceiptPayload({
    ...receipt,
    metadata: {
      ...(receipt.metadata || {}),
      mutationOperationId: operationId,
      committedAt,
    },
  }, {
    verdict: toCanonicalVerdict('admission', receipt.decision),
  });
}

const {
  AXIOM_ERROR,
  CONTRACT_VERSION,
  DEFAULT_CAPABILITIES,
} = require('./lib/kernel-contract');
const { recordCliMutationAudit } = require('./lib/cli-mutation-audit');
const { admitAddCandidateClaim, admitCandidateIngress, admitLearn } = require('./lib/kernel-mutation-admission');

// ProvenanceError is owned by lib/errors/provenance-error.js so that
// lib/provenance-ingest.js can throw it without requiring kernel.js back
// (issue #327). Re-exported below to preserve Kernel.ProvenanceError.
const { ProvenanceError } = require('./lib/errors/provenance-error');

// #357: the admission bypass used to be gated purely on two plain,
// string-keyed opts fields (`admissionRequired === false` +
// `admissionBypassReason` non-empty). ANY caller of the public learn()
// method -- an SDK consumer, a plugin, a future HTTP route, or code that
// carelessly spreads caller-supplied/JSON-decoded input into opts -- could
// produce that exact shape and walk straight past the memory-admission
// gate. There was no way to tell "kernel's own internal bootstrap" apart
// from "whatever object someone handed to learn()".
//
// The bypass is now gated on this module-private Symbol instead. It is
// never exported, so no code outside this file can reference it directly --
// and critically, a Symbol-keyed property cannot survive JSON.stringify/
// JSON.parse or object-literal spread of a plain object, so it cannot be
// forged by decoding untrusted input (HTTP body, MCP tool args, CLI argv)
// into an opts object, no matter how that decoding is written. The only
// way to produce a valid bypass opts object is to call
// Kernel.createAdmissionBypassOpts(reason), exported below, which requires
// the caller to already have required('./kernel') -- i.e. be trusted code
// running in this process, not data arriving over a wire.
const ADMISSION_BYPASS_TOKEN = Symbol('huqan-kernel-internal-admission-bypass');

class Kernel {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.noLoad=false] - true ise memory.json yüklenmez (test için)
   * @param {string}  [opts.memoryPath]   - özel hafıza dosyası yolu
   */
  constructor(opts = {}) {
    const graphOpts = {};
    if (opts.memoryPath) graphOpts.memoryPath = opts.memoryPath;
    if (opts.dbPath) graphOpts.dbPath = opts.dbPath;
    if (opts.useSQLite !== undefined) graphOpts.useSQLite = opts.useSQLite;
    if (opts.noLoad && !opts.memoryPath && !opts.dbPath && opts.useSQLite === undefined) {
      graphOpts.useSQLite = false;
    }
    this.graph = new Graph(graphOpts);
    this._readUseCases = createKernelReadUseCases({
      getGraph: () => this.graph,
      emitPlugin: (...args) => this.plugins.emit(...args),
      normalizeWord: word => this.normalizeWord(word),
      ok: (...args) => this.ok(...args),
      reason: (...args) => this.reason(...args),
      alternatives: (...args) => this.alternatives(...args),
      forwardChain: (...args) => this._forwardChain(...args),
      backwardChain: (...args) => this._backwardChain(...args),
      detectCycle: (...args) => this._detectCycle(...args),
      resolveCycleOrder: (...args) => this._resolveCycleOrder(...args),
      findPath: (...args) => this._findPath(...args),
      edgeEvidence: (...args) => this._edgeEvidence(...args),
      pathEvidence: (...args) => this._pathEvidence(...args),
      edgeRef: (...args) => this._edgeRef(...args),
    });
    if (!opts.noLoad) this.graph.load();
    this.paranoidMode = opts.paranoidMode === true || readCompatibleEnvironmentVariable('PARANOID') === '1';
    this.contractVersion = CONTRACT_VERSION;
    this.lang = opts.lang || readCompatibleEnvironmentVariable('LANG') || 'tr';
    this.nlp = createNlp(this.lang);
    this.capabilities = { ...DEFAULT_CAPABILITIES, ...(opts.capabilities || {}) };
    this._rust = hasRust ? new RustGraph() : null;
    this.plugins = new PluginManager(this);
    if (opts.loadPlugins !== false) {
      const pDir = path.join(__dirname, 'plugins');
      if (fs.existsSync(pDir)) this.plugins.load(pDir);
    }
    this._verifyService = new VerifyService(this, {
      verifyInternal: this._verifyInternal.bind(this),
      parsePredicate: this._parsePredicate.bind(this),
      edgeEvidence: this._edgeEvidence.bind(this),
      findPathWithTimeout: this._findPathWithTimeout.bind(this),
      findPath: this._findPath.bind(this),
      pathEvidence: this._pathEvidence.bind(this),
      edgeRef: this._edgeRef.bind(this),
    });
    this.strictProvenance = opts.strictProvenance === true; this.trustPolicyPath = typeof opts.trustPolicyPath === 'string' && opts.trustPolicyPath.trim() ? opts.trustPolicyPath.trim() : null;
    
    // r1: single-flight guard for critical operations (verify/learn), enforced
    // synchronously by _enterCriticalSection()/_exitCriticalSection() below.
    // Can be disabled with enableConcurrencyLock=false for backward compatibility.
    this._enableConcurrencyLock = opts.enableConcurrencyLock !== false;
    this._lockAcquired = false;

    // v0.9.1: HUQAN Memory Core — kernel.memory API
    this.memory = new MemoryStore({
      trustPolicyVersion: this.contractVersion,
      useSQLite: opts.memoryStoreUseSQLite !== undefined ? opts.memoryStoreUseSQLite : opts.useSQLite,
      dbPath: opts.memoryStoreDbPath || opts.dbPath,
      memoryPath: opts.memoryStorePath || (opts.memoryPath ? siblingPersistencePath(opts.memoryPath, '.memory-store.json') : undefined),
    });

    // Hook graph.close to also close the memory store (see memory-store-utils).
    hookGraphCloseForMemoryStore(this);
  }

  /**
   * Ephemeral, isolated reasoning sandbox: batch-learns statements and answers
   * questions against a throwaway graph that is never persisted and never
   * touches this.graph (no workspace/provenance/audit semantics apply here —
   * for that, use learn()/verify() against the real knowledge graph).
   *
   * Uses the Rust accelerator's `batch` command (one IPC round trip for all
   * learn statements, one more for all questions) when huqan-core is built;
   * otherwise falls back to an in-memory JS Graph so behavior is identical
   * either way, just slower.
   *
   * @param {object} input
   * @param {string[]} [input.learn] - statements to learn (e.g. "elma meyvedir")
   * @param {string[]} [input.ask]   - questions to ask after learning
   * @returns {Promise<{ backend: 'rust'|'js', answers: string[] }>}
   */
  async reasonSandbox({ learn = [], ask = [] } = {}) {
    if (this._rust) {
      // Deliberately NOT this._rust: huqan-core keeps one mutable Graph for the
      // life of its process, so the kernel's shared bridge is not a sandbox.
      // runRustSandbox spawns a private process per call and tears it down (#758).
      const result = await runRustSandboxResult({ learn, ask });
      if (result) return result;
      // Rust unusable or died mid-flight: fall through to the JS sandbox below.
    }
    // JS fallback uses a throwaway Kernel (learn()/ask() live on Kernel, not
    // Graph) so behavior matches the non-sandbox path when Rust is absent.
    // Its answers use Kernel's full NLP pipeline rather than huqan-core's
    // simplified Turkish-suffix parser, so exact wording can differ from the
    // Rust backend — that asymmetry between the two engines predates this
    // method (rustGraph.js's own learn/ask already talk to a different
    // algorithm than Kernel's).
    const sandbox = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
    const bypass = { [ADMISSION_BYPASS_TOKEN]: true, admissionBypassReason: 'reasonSandbox: ephemeral, unpersisted kernel' };
    for (const text of learn) sandbox.learn(text, bypass);
    const answers = ask.map(question => sandbox.ask(question)?.data?.answer || 'Bilmiyorum');
    if (typeof sandbox.graph?.close === 'function') sandbox.graph.close();
    return { backend: 'js', answers };
  }

  _enterCriticalSection(operation = 'operation') {
    if (!this._enableConcurrencyLock) return false;
    if (this._lockAcquired) {
      const error = new Error(`Critical section busy during ${operation}`);
      error.code = 'LOCK_BUSY';
      error.operation = operation;
      throw error;
    }
    this._lockAcquired = true;
    return true;
  }

  _exitCriticalSection() {
    if (!this._enableConcurrencyLock) return;
    this._lockAcquired = false;
  }

  // F-003: Plugin-facing admission-gated edge write.
  // Replaces direct kernel.graph.addEdge() calls in plugins.
  proposeEdge(from, to, relation, opts = {}) {
    return this._commitBackgroundEdge(from, to, relation, 'plugin', {
      workspaceId: opts.workspaceId || 'default',
      edgeOptions: opts,
      provenanceExtra: provenanceFieldsFrom(opts),
      admissionOpts: {
        approvalRequired: false,
        sourceType: opts.sourceType || 'plugin',
        sourceRef: opts.sourceRef || '',
        actor: opts.actor || opts.sessionId || 'plugin',
        agentId: opts.sessionId || 'plugin',
      },
    });
  }

  // F-003: Plugin-facing admission-gated node write.
  proposeNode(id, label, provenance, opts = {}) {
    return runProposeNode({ graph: this.graph, contractVersion: this.contractVersion, trustPolicyPath: this.trustPolicyPath, evaluateLearnAdmission: (...args) => this._evaluateLearnAdmission(...args), appendAuditEvent: (...args) => this._appendAuditEvent(...args), admissionReceiptDetails: admission => this._admissionReceiptDetails(admission) }, id, label, provenance, opts);
  }

  _appendAuditEvent(event, provenance = null, workspaceId = 'default') {
    if (!this.graph || typeof this.graph.appendAuditEvent !== 'function') return null;
    try {
      return this.graph.appendAuditEvent(event, provenance ? { provenance, workspaceId } : { workspaceId });
    } catch (error) {
      console.error('[Kernel] Audit log error:', error.message);
      return null;
    }
  }

  recordCliMutationAudit(intent) {
    return recordCliMutationAudit(this.graph, intent);
  }
  /**
   * K2 (#328, docs/kernel-split-plan.md): admission-gated background edge
   * commit -- now a delegation to lib/background-provenance.js's
   * commitBackgroundEdge(deps)(from, to, relation, source, opts). The
   * function body is the single authoritative implementation; Kernel only
   * injects its instance methods as dependencies. Behaviour is unchanged.
   * FAZ2-PR3 (F-001): routes the edge through _evaluateLearnAdmission
   * (same gate the user-facing learn path uses), writes the canonical edge
   * with provenance + source metadata on 'allow' (LEARN audit), or records
   * REVIEW/REJECT without writing on every other outcome (fail-closed).
   *
   * @returns {{decision: string, edge: object|null, audit: object|null, admission: object|null}}
   */
  commitBackgroundEdge(from, to, relation, source, opts = {}) {
    return commitBackgroundEdge({
      contractVersion: this.contractVersion,
      trustPolicyPath: this.trustPolicyPath,
      evaluateLearnAdmission: (text, admissionOpts, provenance, workspaceId) =>
        this._evaluateLearnAdmission(text, admissionOpts, provenance, workspaceId),
      appendAuditEvent: (event, provenance, workspaceId) =>
        this._appendAuditEvent(event, provenance, workspaceId),
      admissionReceiptDetails: admission => this._admissionReceiptDetails(admission),
      addEdge: (f, t, rel, edgeOptions) => this.graph.addEdge(f, t, rel, edgeOptions),
    })(from, to, relation, source, opts);
  }

  _commitBackgroundEdge(from, to, relation, source, opts = {}) { return this.commitBackgroundEdge(from, to, relation, source, opts); }
  _isLearnAdmissionBypass(opts = {}) {
    return opts[ADMISSION_BYPASS_TOKEN] === true &&
      typeof opts.admissionBypassReason === 'string' &&
      opts.admissionBypassReason.trim().length > 0;
  }

  _evaluateLearnAdmission(text, opts = {}, provenance = null, workspaceId = 'default') {
    return evaluateLearnAdmission({
      kernel: this,
      isLearnAdmissionBypass: this._isLearnAdmissionBypass.bind(this),
      contractVersion: this.contractVersion,
    }, text, opts, provenance, workspaceId);
  }

  _admissionReceiptDetails(admission) {
    if (!admission || typeof admission !== 'object') return {};
    return { ...(admission.receiptId ? { receiptId: admission.receiptId } : {}), ...(admission.receipt && typeof admission.receipt === 'object' ? { receipt: JSON.parse(JSON.stringify(admission.receipt)) } : {}) };
  }

  // The async form of learn(). It does NOT add locking: the critical
  // section is entered inside learn() itself, so learnAsync() is not the
  // "concurrency-safe" variant of an unsafe learn() (#368).
  //
  // What it does add is the async pre-ingest pass.
  //
  // #348: this is also the async pre-ingest entry point. Callers that can
  // await (CLI, MCP, adapters) get preIngest hooks -- which are allowed to
  // do network I/O -- run before the synchronous learn() pipeline starts.
  // With no preIngest plugin registered this stays a pass-through, so the
  // behaviour of every existing caller is unchanged.
  async learnAsync(text, opts = {}) {
    const prepared = await this._runPreIngest(text, opts);
    return this.learn(prepared.text, prepared.opts || opts);
  }

  // The synchronous learn path. It takes the critical section itself
  // (_enterCriticalSection below), so this is concurrency-guarded on its
  // own; learnAsync() wraps it for the preIngest pass, not for safety
  // (#368). What this path cannot do is run async preIngest hooks -- a
  // caller that needs those must await learnAsync().
  //
  // #216 (gap 4): every learn() call now goes through the durable mutation
  // journal, not just callers that explicitly pass mutationOperationId. A
  // caller-supplied id is used as-is (so MCP's approval-id-as-operation-id
  // scheme is unchanged); otherwise one is generated internally so legacy
  // callers (CLI, plugins, direct API use) get the same idempotent-replay
  // and crash-safety guarantee, not just MCP-approved learns.
  learn(text, opts = {}) {
    return runLearnTransaction({ graph: this.graph, kernel: this, enterCriticalSection: (op) => this._enterCriticalSection(op), exitCriticalSection: () => this._exitCriticalSection(), appendAuditEvent: (...args) => this._appendAuditEvent(...args), admit: (k, t, o) => admitLearn(k, t, o), runUseCase: (k, t, o, d) => runLearnUseCase(k, t, o, d), buildCanonicalReceipt: (receipt, operationId, committedAt) => buildLearnCanonicalReceipt(receipt, operationId, committedAt) }, text, opts);
  }

  // r1: Internal learn implementation
  addCandidateClaim(candidate, opts = {}) {
    return admitAddCandidateClaim(this, candidate, opts);
  }

  getCandidateClaims(filters = {}) {
    if (!this.graph || typeof this.graph.getCandidateClaims !== 'function') {
      return [];
    }
    return this.graph.getCandidateClaims(filters);
  }

  ingestCandidateClaim(input = {}, opts = {}) {
    return admitCandidateIngress(this, input, opts, null, (text, admissionOpts, provenance, workspaceId) =>
      this._evaluateLearnAdmission(text, admissionOpts, provenance, workspaceId));
  }

  // Periyodik bakım — sayım ve guard lib/kernel-self-evolve içindedir.
  _learnCount = 0;
  maintenanceEvery = 5;
  _maintenanceRunning = false;


}

// Method groups that moved out of this file (#2122). Each is installed with
// the descriptor it had as a class member; see lib/kernel-method-install.js.
installCapabilityMethods(Kernel);
installPrimitiveMethods(Kernel);
installReadMethods(Kernel);
installPersistenceMethods(Kernel);
installLearnInputMethods(Kernel);
installCognitionMethods(Kernel, Dream);

module.exports = Kernel;
module.exports.AXIOM_ERROR = AXIOM_ERROR;
module.exports.CONTRACT_VERSION = CONTRACT_VERSION;
module.exports.ProvenanceError = ProvenanceError;

// #357: the only way to construct a learn() opts object that bypasses the
// memory-admission gate. Requires require()-ing this module, so it can only
// be produced by trusted code running in this process -- never by decoding
// untrusted input (HTTP body, MCP tool args, CLI argv, plugin-forwarded
// input) into a plain object, since a Symbol-keyed property cannot survive
// JSON.stringify/parse or plain-object spread. `reason` must be a non-empty
// string; every bypass is expected to explain itself for the same reason
// the old string-keyed convention did (audit readability), not because the
// string carries any authority of its own -- the token does.
module.exports.createAdmissionBypassOpts = function createAdmissionBypassOpts(reason) {
  if (typeof reason !== 'string' || !reason.trim()) {
    throw new TypeError('createAdmissionBypassOpts(reason): reason must be a non-empty string');
  }
  return { [ADMISSION_BYPASS_TOKEN]: true, admissionBypassReason: reason };
};
