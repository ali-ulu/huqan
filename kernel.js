const Graph = require('./graph');
const Dream = require('./dream');
const fs = require('fs');
const path = require('path');
const PluginManager = require('./plugin');
const createNlp = require('./nlp');
const VerifyService = require('./lib/verify');
const { buildProvenance } = require('./lib/provenance-ingest');
const { buildBackgroundProvenance, provenanceFieldsFrom } = require('./lib/background-provenance');
const { buildLearnAdmissionRequest } = require('./lib/learn-admission-request');
const { evaluateMemoryAdmission } = require('./lib/memory-admission-gate');
const { emitGateTelemetry } = require('./lib/gate-telemetry');
const { defaultApprovalRequired } = require('./lib/human-approval-toggle');
const { detectClaimConflict } = require('./lib/conflict-detector');
const { createKernelReadUseCases } = require('./lib/kernel-read-use-cases');
const { runLearnUseCase } = require('./lib/learn-use-case');
const MemoryStore = require('./lib/memory-store');
const { buildCanonicalReceiptPayload } = require('./lib/receipt/canonical-receipt');
const { toCanonicalVerdict } = require('./lib/verdict/action-verdict');
const { readCompatibleEnvironmentVariable } = require('./lib/environment-compat');
const { runRustSandbox } = require('./lib/reason-sandbox');

let RustGraph;
try { RustGraph = require('./rustGraph'); } catch {}
const RUST_BIN = readCompatibleEnvironmentVariable('RUST_BIN') || (RustGraph && RustGraph.resolveRustBin ? RustGraph.resolveRustBin() : undefined);
const hasRust = !!RUST_BIN && fs.existsSync(RUST_BIN) && typeof RustGraph !== 'undefined';

const AXIOM_ERROR = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  CONFLICT_DETECTED: 'CONFLICT_DETECTED',
  GRAPH_UNAVAILABLE: 'GRAPH_UNAVAILABLE',
  NORMALIZATION_FAILED: 'NORMALIZATION_FAILED',
  LLM_DISABLED: 'LLM_DISABLED',
  INTERNAL: 'INTERNAL',
});

const CONTRACT_VERSION = '1.0.0';
const DEFAULT_CAPABILITIES = Object.freeze({
  graph: true,
  temporal: false,
  pluginCapabilities: false,
  llm: true,
  contradictionDetection: true,
  evidenceRanking: false,
  agentApi: false,
  companyMode: false,
  discoveryLoop: false,
  // Off by default: turning this on makes learnAsync() reach out to the
  // network to check that an http(s) sourceRef actually resolves, which is
  // the wrong default for offline use and for the test suite. See #348.
  evidenceReachability: false,
});
const {
  CLI_MUTATION_AUDIT_FIELDS,
  CLI_MUTATION_AUDIT_REQUIRED_FIELDS,
  CLI_MUTATION_AUDIT_APPROVAL_STATES,
  CLI_MUTATION_AUDIT_MAPPINGS,
  normalizeWorkspaceId,
} = require('./lib/cli-mutation-audit-intent');
const { recordCliMutationAudit } = require('./lib/cli-mutation-audit');
const { admitCandidateIngress, admitLearn } = require('./lib/kernel-mutation-admission');
const {
  normalizeExplicitRelationObject,
  parseExplicitRelationPredicate,
  parsePredicate,
} = require('./lib/predicate-parser');
const {
  forwardChain,
  backwardChain,
  detectCycle,
  resolveCycleOrder,
  findPath,
  findPathWithTimeout,
} = require('./lib/graph-traversal');
const {
  ok: envelopeOk,
  fail: envelopeFail,
  validateResult,
  edgeRef,
  rankEvidence,
  edgeEvidence,
  pathEvidence,
} = require('./lib/kernel-envelope');
const { buildIntrospectReport } = require('./lib/kernel-introspect-report');

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
const ADMISSION_BYPASS_TOKEN = Symbol('axiom-kernel-internal-admission-bypass');

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
      ok: (...args) => this._ok(...args),
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
    this._verifyService = new VerifyService(this);
    this.strictProvenance = opts.strictProvenance === true;
    
    // r1: single-flight guard for critical operations (verify/learn), enforced
    // synchronously by _enterCriticalSection()/_exitCriticalSection() below.
    // Can be disabled with enableConcurrencyLock=false for backward compatibility.
    this._enableConcurrencyLock = opts.enableConcurrencyLock !== false;
    this._lockAcquired = false;

    // v0.9.1: AXIOM Memory Core — kernel.memory API
    this.memory = new MemoryStore({
      trustPolicyVersion: this.contractVersion,
      useSQLite: opts.memoryStoreUseSQLite !== undefined ? opts.memoryStoreUseSQLite : opts.useSQLite,
      dbPath: opts.memoryStoreDbPath || opts.dbPath,
      memoryPath: opts.memoryStorePath || opts.memoryPath,
    });

    // Hook graph.close to also close memory store db connection
    const originalClose = this.graph.close;
    this.graph.close = () => {
      if (typeof originalClose === 'function') {
        originalClose.call(this.graph);
      }
      if (this.memory && typeof this.memory.close === 'function') {
        this.memory.close();
      }
    };
  }

  /**
   * Ephemeral, isolated reasoning sandbox: batch-learns statements and answers
   * questions against a throwaway graph that is never persisted and never
   * touches this.graph (no workspace/provenance/audit semantics apply here —
   * for that, use learn()/verify() against the real knowledge graph).
   *
   * Uses the Rust accelerator's `batch` command (one IPC round trip for all
   * learn statements, one more for all questions) when axiom-core is built;
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
      // Deliberately NOT this._rust: axiom-core keeps one mutable Graph for the
      // life of its process, so the kernel's shared bridge is not a sandbox.
      // runRustSandbox spawns a private process per call and tears it down (#758).
      const answers = await runRustSandbox({ learn, ask });
      if (answers) return { backend: 'rust', answers };
      // Rust unusable or died mid-flight: fall through to the JS sandbox below.
    }
    // JS fallback uses a throwaway Kernel (learn()/ask() live on Kernel, not
    // Graph) so behavior matches the non-sandbox path when Rust is absent.
    // Its answers use Kernel's full NLP pipeline rather than axiom-core's
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

  hasCapability(name) {
    return Boolean(this.capabilities && this.capabilities[name] === true);
  }

  enableCapability(name) {
    if (!name || !(name in DEFAULT_CAPABILITIES)) {
      const error = new Error(`Unknown capability: ${name}`);
      error.code = 'CAPABILITY_UNKNOWN';
      error.capability = name;
      throw error;
    }
    this.capabilities[name] = true;
    if (
      this.plugins &&
      typeof this.plugins.emit === 'function' &&
      this.plugins._handlers &&
      Array.isArray(this.plugins._handlers['capability:enabled'])
    ) {
      this.plugins.emit('capability:enabled', { name });
    }
    return true;
  }

  requireCapability(name) {
    if (this.hasCapability(name)) return true;
    const error = new Error(`Required capability is not enabled: ${name}`);
    error.code = 'CAPABILITY_REQUIRED';
    error.capability = name;
    throw error;
  }

  normalizeWord(word) {
    return this.nlp.normalize(word);
  }

  tokenizeText(text) {
    return this.nlp.tokenize(text);
  }

  isStopWord(word) {
    return this.nlp.isStopWord(word);
  }

  extractFacts(text, knownNodes = null) {
    return this.nlp.extractFacts(text, knownNodes);
  }

  usePlugin(plugin) {
    this.plugins.register(plugin);
  }

  listCapabilities() {
    if (!this.plugins || typeof this.plugins.listCapabilities !== 'function') return [];
    return this.plugins.listCapabilities();
  }

  getCapability(name) {
    if (!this.plugins || typeof this.plugins.getCapability !== 'function') return null;
    return this.plugins.getCapability(name);
  }

  async runCapability(name, input, opts = {}) {
    this.requireCapability('pluginCapabilities');
    if (!this.plugins || typeof this.plugins.runCapability !== 'function') {
      throw new Error('Plugin manager is unavailable.');
    }
    return this.plugins.runCapability(name, input, opts);
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
    if (!this.graph || typeof this.graph.addNode !== 'function') {
      return { decision: 'review', node: null, audit: null, admission: null };
    }

    const workspaceId = normalizeWorkspaceId(opts.workspaceId || provenance?.workspaceId || 'default');
    const pluginProvenance = provenance && typeof provenance === 'object'
      ? provenance
      : this._backgroundProvenance('plugin', workspaceId, {
        sourceType: opts.sourceType || 'plugin',
        sourceRef: opts.sourceRef || '',
        actor: opts.actor || opts.sessionId || 'plugin',
      });
    const proposalText = `${id} ${label || id}`;
    const admissionOpts = {
      workspaceId,
      provenanceId: pluginProvenance.provenanceId,
      actor: pluginProvenance.actor,
      agentId: opts.sessionId || pluginProvenance.actor,
      sourceType: pluginProvenance.sourceType,
      sourceRef: pluginProvenance.sourceRef,
      approvalRequired: false,
      admissionReason: 'background_plugin_node_write',
      admissionContext: {
        backgroundSource: 'plugin',
        nodeId: id,
      },
    };
    const admission = this._evaluateLearnAdmission(proposalText, admissionOpts, pluginProvenance, workspaceId);

    if (!admission) {
      const audit = this._appendAuditEvent({
        eventType: 'REVIEW',
        targetType: 'background_node',
        targetId: id,
        details: {
          backgroundSource: 'plugin',
          reason: 'admission_unavailable',
          nodeId: id,
          label: label || id,
        },
      }, pluginProvenance, workspaceId);
      return { decision: 'review', node: null, audit, admission: null };
    }

    if (admission.outcome !== 'allow') {
      const audit = this._appendAuditEvent({
        eventType: admission.outcome === 'reject' ? 'REJECT' : 'REVIEW',
        targetType: 'background_node',
        targetId: id,
        details: {
          backgroundSource: 'plugin',
          reason: admission.reason,
          admissionOutcome: admission.outcome,
          approvalStatus: admission.approvalStatus,
          ...this._admissionReceiptDetails(admission),
          nodeId: id,
          label: label || id,
        },
      }, pluginProvenance, workspaceId);
      return { decision: admission.outcome, node: null, audit, admission };
    }

    const node = this.graph.addNode(id, label, pluginProvenance, { ...opts, workspaceId });
    const audit = this._appendAuditEvent({
      eventType: 'LEARN',
      targetType: 'background_node',
      targetId: id,
      details: {
        backgroundSource: 'plugin',
        nodeId: id,
        label: label || id,
        admissionOutcome: 'allow',
        ...this._admissionReceiptDetails(admission),
      },
    }, pluginProvenance, workspaceId);
    return { decision: 'allow', node, audit, admission };
  }

  // Implementations live in lib/kernel-envelope.js. These stay as methods
  // because lib/verify.js, lib/learn-use-case.js, lib/kernel-read-use-cases.js,
  // plugins and the test suite all call them off a kernel instance.
  get _envelopeContext() {
    return { graph: this.graph, contractVersion: this.contractVersion, paranoidMode: this.paranoidMode };
  }

  _ok(type, data = null, evidence = [], meta = {}) {
    return envelopeOk(this._envelopeContext, type, data, evidence, meta);
  }

  _fail(type, code, message, meta = {}) {
    return envelopeFail(this._envelopeContext, type, code, message, meta);
  }

  _validateResult(result) {
    return validateResult(result);
  }

  _edgeRef(edge) {
    return edgeRef(edge);
  }

  _rankEvidence(evidence = []) {
    return rankEvidence(evidence);
  }

  _edgeEvidence(edge, kind = 'direct_edge', confidence) {
    return edgeEvidence(edge, kind, confidence);
  }

  _pathEvidence(pathArr, kind = 'path', confidence = 0.5, workspaceId = 'default') {
    return pathEvidence(this.graph, pathArr, kind, confidence, workspaceId);
  }

  _runBeforeLearn(text, opts = {}) {
    const payload = { text, opts: { ...opts } };
    if (this.plugins && typeof this.plugins.emitStrict === 'function') {
      return this.plugins.emitStrict('beforeLearn', payload);
    }
    if (this.plugins && typeof this.plugins.emit === 'function') {
      return this.plugins.emit('beforeLearn', payload);
    }
    return payload;
  }

  /**
   * Async pre-ingest pass, run by learnAsync() before the synchronous
   * learn() pipeline is entered. Handlers may do I/O; a rejection aborts
   * the learn entirely (fail-closed), and the possibly-rewritten
   * {text, opts} is what learn() then receives.
   *
   * This is the answer to #348 that does *not* require making the whole
   * kernel API async: async validation happens here, ahead of learn(),
   * rather than inside the synchronous beforeLearn hook.
   */
  async _runPreIngest(text, opts = {}) {
    const payload = { text, opts: { ...opts } };
    if (!this.plugins || typeof this.plugins.emitStrictAsync !== 'function') return payload;
    if (!this.plugins._handlers || !this.plugins._handlers.preIngest || this.plugins._handlers.preIngest.length === 0) {
      return payload;
    }
    const result = await this.plugins.emitStrictAsync('preIngest', payload);
    // A handler that returns something non-payload-shaped would otherwise
    // reproduce exactly the silent corruption #348 is about, one layer up.
    if (!result || typeof result !== 'object' || typeof result.text !== 'string') {
      const error = new Error('preIngest hook returned a value without a string "text" field; refusing to learn from it');
      error.code = 'PRE_INGEST_INVALID_PAYLOAD';
      throw error;
    }
    return result;
  }

  _contradictionEvidence(contradiction) {
    return this._verifyService._contradictionEvidence(contradiction);
  }

  _resolveLearnMetadata(opts = {}) {
    const sourceType = typeof opts.sourceType === 'string' ? opts.sourceType.trim() : '';
    const sourceRef = typeof opts.sourceRef === 'string' ? opts.sourceRef.trim() : '';
    const sessionId = typeof opts.sessionId === 'string' ? opts.sessionId.trim() : '';
    const evidenceType = typeof opts.evidenceType === 'string' ? opts.evidenceType.trim() : '';
    const explicitCompanyMode = typeof opts.companyMode === 'boolean' ? opts.companyMode : this.hasCapability('companyMode');
    const companyMode = explicitCompanyMode && this.hasCapability('companyMode');
    return {
      sourceType,
      sourceRef,
      sessionId,
      evidenceType,
      companyMode,
    };
  }

  _learnEdgeOptions(base, meta, text) {
    const options = {
      ...base,
      evidence: Array.isArray(base.evidence) ? base.evidence : [text],
    };
    if (meta.sourceRef) options.sourceRef = meta.sourceRef;
    if (meta.sessionId) options.sessionId = meta.sessionId;
    if (meta.sourceType) options.sourceType = meta.sourceType;
    if (meta.evidenceType) options.evidenceType = meta.evidenceType;
    if (meta.companyMode) options.companyMode = true;
    return options;
  }

  _normalizeProvenanceInput(provenanceInput, opts = {}) {
    if (!provenanceInput && !opts.sourceType && !opts.sourceRef && !opts.sourceTitle && !opts.actor && !opts.timestamp && !opts.workspaceId) {
      return { provenance: null, warnings: [] };
    }

    return buildProvenance(provenanceInput || {}, {
      strictProvenance: this.strictProvenance,
      trustPolicy: opts.trustPolicy,
      trustPolicyPath: opts.trustPolicyPath,
      sourceType: opts.sourceType,
      sourceSubType: opts.sourceSubType,
      sourceRef: opts.sourceRef,
      sourceTitle: opts.sourceTitle,
      actor: opts.actor,
      timestamp: opts.timestamp,
      workspaceId: opts.workspaceId,
    });
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
   * FAZ2-PR3 (F-001): Background-source synthetic provenance for autonomous
   * mutation paths (_autoThinkTick, dream(learnFromDream), selfEvolve,
   * _crossLink).  Background mutations MUST carry a source/actor/provenanceId
   * so admission and audit can attribute them.  This is NOT a bypass — the
   * synthetic provenance is fed into the same admission gate as user writes,
   * which by default returns 'review' for low-trust background actors and
   * therefore prevents silent canonical writes.
   */
  _backgroundProvenance(source, workspaceId = 'default', extra = {}) {
    return buildBackgroundProvenance(source, workspaceId, extra, {
      contractVersion: this.contractVersion,
      trustPolicyPath: this.trustPolicyPath,
    });
  }

  /**
   * FAZ2-PR3 (F-001): Admission-gated background edge commit.
   *
   * - Builds synthetic provenance describing the background source.
   * - Routes the proposed edge through _evaluateLearnAdmission (same gate the
   *   user-facing learn path uses).
   * - On 'allow' decision: writes the edge with source/provenance metadata and
   *   emits a LEARN audit event tagged background:<source>.
   * - On 'review' or 'reject' (the default for synthetic background
   *   provenance): does NOT write the canonical edge and emits a
   *   REVIEW/REJECT audit event so the attempt is recorded.
   *
   * @returns {{decision: string, edge: object|null, audit: object|null, admission: object|null}}
   */
  _commitBackgroundEdge(from, to, relation, source, opts = {}) {
    const workspaceId = normalizeWorkspaceId(opts.workspaceId || 'default');
    const provenance = this._backgroundProvenance(source, workspaceId, opts.provenanceExtra || {});
    const proposalText = `${from} ${relation} ${to}`;
    const admissionOpts = {
      ...(opts.admissionOpts || {}),
      workspaceId,
      provenanceId: provenance.provenanceId,
      actor: provenance.actor,
      agentId: provenance.actor,
      sourceType: provenance.sourceType,
      sourceRef: provenance.sourceRef,
      admissionReason: `background_${source}_edge_write`,
      admissionContext: {
        ...(opts.admissionOpts && opts.admissionOpts.admissionContext) || {},
        backgroundSource: source,
      },
    };
    const admission = this._evaluateLearnAdmission(proposalText, admissionOpts, provenance, workspaceId);

    // Admission missing (shouldn't happen for background paths) — treat as review for safety.
    if (!admission) {
      const audit = this._appendAuditEvent({
        eventType: 'REVIEW',
        targetType: 'background_edge',
        targetId: `${from}|${relation}|${to}`,
        details: {
          backgroundSource: source,
          reason: 'admission_unavailable',
          from,
          to,
          relation,
        },
      }, provenance, workspaceId);
      return { decision: 'review', edge: null, audit, admission: null };
    }

    if (admission.outcome !== 'allow') {
      const audit = this._appendAuditEvent({
        eventType: admission.outcome === 'reject' ? 'REJECT' : 'REVIEW',
        targetType: 'background_edge',
        targetId: `${from}|${relation}|${to}`,
        details: {
          backgroundSource: source,
          reason: admission.reason,
          admissionOutcome: admission.outcome,
          approvalStatus: admission.approvalStatus,
          ...this._admissionReceiptDetails(admission),
          from,
          to,
          relation,
        },
      }, provenance, workspaceId);
      return { decision: admission.outcome, edge: null, audit, admission };
    }

    // Allowed — write the canonical edge with provenance + source metadata.
    const edgeOptions = {
      ...(opts.edgeOptions || {}),
      workspaceId,
      provenance,
      source: opts.edgeOptions && opts.edgeOptions.source
        ? opts.edgeOptions.source
        : `background:${source}`,
    };
    const edge = this.graph.addEdge(from, to, relation, edgeOptions);
    const audit = this._appendAuditEvent({
      eventType: 'LEARN',
      targetType: 'background_edge',
      targetId: edge ? `${edge.from}|${edge.relation}|${edge.to}` : `${from}|${relation}|${to}`,
      details: {
        backgroundSource: source,
        from,
        to,
        relation,
        admissionOutcome: 'allow',
        ...this._admissionReceiptDetails(admission),
      },
    }, provenance, workspaceId);
    return { decision: 'allow', edge, audit, admission };
  }

  _isLearnAdmissionBypass(opts = {}) {
    return opts[ADMISSION_BYPASS_TOKEN] === true &&
      typeof opts.admissionBypassReason === 'string' &&
      opts.admissionBypassReason.trim().length > 0;
  }

  _evaluateLearnAdmission(text, opts = {}, provenance = null, workspaceId = 'default') {
    if (this._isLearnAdmissionBypass(opts)) return null;

    const request = buildLearnAdmissionRequest({
      text,
      opts,
      provenance,
      workspaceId,
      contractVersion: this.contractVersion,
    });

    const evaluated = evaluateMemoryAdmission(request, {
      approvalRequired: request.approvalRequired,
    });
    if (!evaluated || !evaluated.ok || !evaluated.decision) {
      emitGateTelemetry(this, 'memory-admission', { decision: 'review', reason: 'memory_admission_evaluation_failed' });
      return {
        outcome: 'review',
        reason: 'memory_admission_evaluation_failed',
        graphWrite: false,
        workspaceId,
      };
    }

    emitGateTelemetry(this, 'memory-admission', evaluated.decision);

    return {
      outcome: evaluated.decision.decision,
      reason: evaluated.decision.reason,
      graphWrite: evaluated.decision.allowed,
      workspaceId,
      approvalStatus: evaluated.decision.approvalStatus,
      provenanceId: evaluated.decision.provenanceId,
      receiptId: evaluated.decision.receiptId,
      receipt: evaluated.decision.receipt,
      trustPolicyVersion: evaluated.decision.trustPolicyVersion,
    };
  }

  _admissionReceiptDetails(admission) {
    if (!admission || typeof admission !== 'object') return {};
    const details = {};
    if (admission.receiptId) details.receiptId = admission.receiptId;
    if (admission.receipt && typeof admission.receipt === 'object') {
      details.receipt = JSON.parse(JSON.stringify(admission.receipt));
    }
    return details;
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
    const { text: nextText, opts: nextOpts } = admitLearn(this, text, opts);
    this._enterCriticalSection('learn');
    try {
      const operationId = typeof nextOpts.mutationOperationId === 'string' && nextOpts.mutationOperationId.trim()
        ? nextOpts.mutationOperationId.trim()
        : `auto-mut-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      if (!this.graph || typeof this.graph.runMutationOnce !== 'function') {
        const error = new Error('durable mutation journal is unavailable');
        error.code = 'DURABLE_MUTATION_JOURNAL_UNAVAILABLE';
        throw error;
      }
      const postCommitEffects = [];
      const runMutationOnceOpts = {
        buildCanonicalReceipt: (learnResult) => {
          const receipt = learnResult?.data?.admission?.receipt;
          // Bypass-mode and admission-free learns produce no admission
          // receipt at all -- that is expected (not every learn goes
          // through the admission gate), so this mutation simply commits
          // without a canonical receipt rather than failing the write.
          if (!receipt || typeof receipt !== 'object') return null;
          const committedAt = new Date().toISOString();
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
        },
      };
      let outcome;
      try {
        outcome = this.graph.runMutationOnce(operationId, () => runLearnUseCase(this, nextText, {
          ...nextOpts,
          _durableMutationTransaction: true,
          _postCommitEffects: postCommitEffects,
        }, {
          normalizeWorkspaceId,
          ProvenanceError,
        }), runMutationOnceOpts);
      } catch (error) {
        // A strictProvenance rejection is an expected, final outcome (not a
        // mid-transaction crash), and learn-use-case.js already appends a
        // REJECT audit event for it before throwing -- but runMutationOnce's
        // rollback-on-error restores in-memory state to the pre-mutation
        // snapshot, which undoes that in-memory audit append along with
        // everything else (correctly so for a genuine crash, where nothing
        // should be left behind). Re-append it here so the rejection itself
        // stays on the audit trail, matching the admission-reject path
        // (which returns normally instead of throwing and is therefore
        // unaffected by rollback).
        if (error instanceof ProvenanceError || error?.code === 'PROVENANCE_REQUIRED') {
          this._appendAuditEvent({
            eventType: 'REJECT',
            targetType: 'learn',
            targetId: nextText,
            details: { reason: error.code || 'PROVENANCE_REQUIRED', message: error.message, text: nextText },
          }, nextOpts.provenance && typeof nextOpts.provenance === 'object' ? nextOpts.provenance : null, normalizeWorkspaceId(nextOpts.workspaceId));
        }
        throw error;
      }
      const result = outcome.result;
      if (result && typeof result === 'object') {
        result.meta = {
          ...(result.meta || {}),
          durableMutation: true,
          replayed: outcome.replayed === true,
          committedReceiptId: outcome.receipt?.receiptId || null,
          committedReceiptHash: outcome.receipt?.receiptHash || null,
        };
      }
      if (!outcome.replayed) {
        // The JSON backend's runMutationOnce already calls save() itself
        // while committing (outcome.persisted === true); only the SQLite
        // path still needs this call here, to sync its JSON fallback export
        // (SQLite's own persistence is the DB transaction, already done).
        if (!outcome.persisted) {
          try { this.graph.save(); } catch (error) { console.error('[Kernel] Graph save error:', error.message); }
        }
        for (const effect of postCommitEffects) {
          try { effect(); } catch (error) { console.error('[Kernel] post-commit effect error:', error.message); }
        }
      }
      return result;
    } finally {
      this._exitCriticalSection();
    }
  }

  // r1: Internal learn implementation
  addCandidateClaim(candidate, opts = {}) {
    if (!this.graph || typeof this.graph.addCandidateClaim !== 'function') {
      throw new Error('Graph candidate claim storage is unavailable.');
    }
    return this.graph.addCandidateClaim(candidate, opts);
  }

  getCandidateClaims(filters = {}) {
    if (!this.graph || typeof this.graph.getCandidateClaims !== 'function') {
      return [];
    }
    return this.graph.getCandidateClaims(filters);
  }

  detectClaimConflict(claim, opts = {}) {
    return detectClaimConflict(this, claim, opts);
  }

  ingestCandidateClaim(input = {}, opts = {}) {
    return admitCandidateIngress(this, input, opts);
  }

  // Implementations live in lib/predicate-parser.js. These stay as methods
  // because plugins (contradiction-alert, company-brain), lib/learn-use-case.js
  // and the test suite call them off a kernel instance.
  _normalizeExplicitRelationObject(rawObject, opts = {}) {
    return normalizeExplicitRelationObject(rawObject, opts, (word) => this.normalizeWord(word));
  }

  _parseExplicitRelationPredicate(predicate) {
    return parseExplicitRelationPredicate(predicate, (word) => this.normalizeWord(word));
  }

  _parsePredicate(predicate) {
    return parsePredicate(predicate, (word) => this.normalizeWord(word));
  }

  /**
   * FAZ2-PR3 (F-001-d): Derive "benzer" (similarity) edges from shared tags.
   *
   * Two entry modes:
   *  - Parent-allowed (context.parentAdmissionAllowed === true):
   *      Invoked from the main learn path AFTER user admission allowed the
   *      parent write.  Derived "benzer" edges inherit parent provenance and
   *      are audited as derived writes; no background admission round-trip
   *      so the derived chain does not deadlock on review-by-default.  This
   *      mirrors the parent admission decision rather than introducing a
   *      separate background gate for a write the user already authorized.
   *  - Background (no context):
   *      Invoked externally (e.g. inference/maintenance).  Routed through
   *      _commitBackgroundEdge so the synthetic provenance is admission-gated.
   *      Default decision is 'review' → no canonical write.
   *
   * Either path produces an audit event so the attempt is observable.
   */
  _crossLink(subject, object, relation, workspaceId = 'default', context = {}) {
    const subjNode = this.graph.getNode(subject, workspaceId);
    const objNode = this.graph.getNode(object, workspaceId);
    if (!subjNode || !objNode) return { written: 0, audits: 0, skipped: 0 };

    const parentAllowed = Boolean(context && context.parentAdmissionAllowed);
    const parentProvenance = context && context.parentProvenance ? context.parentProvenance : null;
    const parentAdmission = context && context.parentAdmission ? context.parentAdmission : null;

    let written = 0;
    let audits = 0;
    let skipped = 0;

    for (const tag of Object.keys(subjNode.vector)) {
      if (tag !== object && this.graph.getNode(tag, workspaceId) && objNode.vector[tag]) {
        const existing = this.graph.getEdge(subject, object, 'benzer', workspaceId);
        if (!existing) {
          if (parentAllowed) {
            // Parent learn admission already permitted the canonical write
            // that triggered this derivation.  Carry parent provenance + audit.
            const edgeOptions = { workspaceId };
            if (parentProvenance) edgeOptions.provenance = parentProvenance;
            edgeOptions.source = (context && context.derivedSource) || 'cross-link';
            const edge = this.graph.addEdge(subject, object, 'benzer', edgeOptions);
            if (edge) {
              written++;
              this._appendAuditEvent({
                eventType: 'LEARN',
                targetType: 'derived_edge',
                targetId: `${edge.from}|${edge.relation}|${edge.to}`,
                details: {
                  derivation: 'cross_link',
                  triggerSubject: subject,
                  triggerObject: object,
                  triggerRelation: relation,
                  via: tag,
                  ...this._admissionReceiptDetails(parentAdmission),
                },
              }, parentProvenance, workspaceId);
              audits++;
            }
          } else {
            // Background invocation — route through admission gate.
            const result = this._commitBackgroundEdge(subject, object, 'benzer', '_crossLink', {
              workspaceId,
              edgeOptions: { source: 'cross-link' },
              provenanceExtra: { derivation: 'cross_link', via: tag },
            });
            if (result.audit) audits++;
            if (result.decision === 'allow' && result.edge) written++;
            else skipped++;
          }
        }
      }
    }

    return { written, audits, skipped };
  }

  ask(question) {
    return this._readUseCases.ask(question);
  }

  alternatives(subject, maxPaths = 3, workspaceId = 'default') {
    const normalized = this.normalizeWord(subject);
    const node = this.graph.getNode(normalized, workspaceId);
    if (!node) {
      return this._ok('alternatives', { subject: normalized, answer: 'Bilmiyorum', paths: [] }, []);
    }

    // 1. Doğrudan kenarlardan alternatif grupları oluştur
    const edges = this.graph.getEdges(normalized, workspaceId);
    const groups = { 'tür': [], yapabilir: [], 'özellik': [], benzer: [], hipotez: [] };
    for (const e of edges) {
      const g = groups[e.relation];
      if (g) g.push(e.to);
    }

    // 2. En yüksek güvenli hedefleri seç, her gruptan bir tane al
    const paths = [];
    const usedNodes = new Set([normalized]);

    // İlişki önceliği: tür > yapabilir > özellik > benzer > hipotez
    const relOrder = ['tür', 'yapabilir', 'özellik', 'benzer', 'hipotez'];

    for (const rel of relOrder) {
      if (paths.length >= maxPaths) break;
      const targets = groups[rel] || [];
      if (targets.length === 0) continue;

      // Güvene göre sırala (yüksekten düşe)
      const sorted = targets
        .map(t => ({ target: t, weight: edges.find(e => e.to === t && e.relation === rel)?.weight || 0.5 }))
        .sort((a, b) => b.weight - a.weight);

      const best = sorted[0];
      if (usedNodes.has(best.target)) continue;

      const subEdges = this.graph.getEdges(best.target, workspaceId).filter(e => !usedNodes.has(e.to));
      const chain = subEdges.slice(0, 2).map(e => ({ node: e.to, rel: e.relation }));
      paths.push({
        type: rel,
        from: normalized,
        to: best.target,
        chain,
        confidence: best.weight,
      });
      usedNodes.add(best.target);
    }

    // 3. Alternatif çözüm olarak değerlendir
    let answer = normalized + ': alternative paths:\n';
    for (const p of paths) {
      answer += `  [${p.type}] ${p.from} → ${p.to}`;
      if (p.chain.length > 0) {
        answer += ` → ${p.chain.map(c => c.node + '(' + c.rel + ')').join(', ')}`;
      }
      answer += ` (confidence: ${p.confidence.toFixed(2)})\n`;
    }
    if (paths.length === 0) answer = 'Bilmiyorum';

    const evidence = paths.map(p => ({
      kind: 'alternative_path',
      text: `${p.from} --[${p.type}]--> ${p.to}`,
      confidence: p.confidence,
      nodes: [p.from, p.to],
      edges: [{ from: p.from, to: p.to, relation: p.type }],
    }));

    return this._ok('alternatives', { subject: normalized, answer, paths }, evidence);
  }

  contextSimilarity(a, b, context) {
    const ctxWeight = {};
    const ctxNode = this.graph.getNode(context);
    if (ctxNode) {
      for (const [dim, w] of Object.entries(ctxNode.vector)) {
        ctxWeight[dim] = w;
      }
    }

    const aNode = this.graph.getNode(a);
    const bNode = this.graph.getNode(b);
    if (!aNode || !bNode) return 0;

    const dims = new Set([
      ...Object.keys(aNode.vector),
      ...Object.keys(bNode.vector),
      ...Object.keys(ctxWeight),
    ]);

    let dot = 0, magA = 0, magB = 0;
    for (const d of dims) {
      const cw = ctxWeight[d] || 1;
      const va = (aNode.vector[d] || 0) * cw;
      const vb = (bNode.vector[d] || 0) * cw;
      dot += va * vb;
      magA += va * va;
      magB += vb * vb;
    }

    const mag = Math.sqrt(magA) * Math.sqrt(magB);
    return mag === 0 ? 0 : dot / mag;
  }

  entropy(workspaceId = 'default') {
    return this._readUseCases.entropy(workspaceId);
  }

  detectGaps(workspaceId = 'default') {
    return this._readUseCases.detectGaps(workspaceId);
  }

  reason(subject, workspaceId = 'default') {
    return this._readUseCases.reason(subject, workspaceId);
  }

  compare(a, b, workspaceId = 'default') {
    return this._readUseCases.compare(a, b, workspaceId);
  }

  _parseNumericComparison(text) {
    return this._verifyService._parseNumericComparison(text);
  }

  // Implementations live in lib/graph-traversal.js. These stay as methods
  // because lib/kernel-read-use-cases.js takes them as injected callbacks,
  // lib/verify.js calls _findPathWithTimeout off the kernel, and the test
  // suite calls them off a kernel instance.
  _forwardChain(id, chain, visited, depth, workspaceId = 'default') {
    return forwardChain(this.graph, id, chain, visited, depth, workspaceId);
  }

  _backwardChain(id, chain, visited, depth, workspaceId = 'default') {
    return backwardChain(this.graph, id, chain, visited, depth, workspaceId);
  }

  _detectCycle(start, visited, pathArr, workspaceId = 'default') {
    return detectCycle(this.graph, start, visited, pathArr, workspaceId);
  }

  _resolveCycleOrder(cycle, workspaceId = 'default') {
    return resolveCycleOrder(this.graph, cycle, workspaceId);
  }

  _findPath(from, to, visited, pathArr, depth, workspaceId = 'default') {
    return findPath(this.graph, from, to, visited, pathArr, depth, workspaceId);
  }

  _findPathWithTimeout(from, to, timeoutMs = 100, workspaceId = 'default', maxDepth = 5) {
    return findPathWithTimeout(this.graph, from, to, timeoutMs, workspaceId, maxDepth);
  }

  // --- Background auto-think ---
  startAutoThink(intervalMs = 10000) {
    if (this._thinkTimer) return;
    this._dreamer = new Dream(this);
    this._thinkTimer = setInterval(() => {
      try {
        this._autoThinkTick();
      } catch (e) {
        console.error('\n[autoThink hata]', e.message);
      }
    }, intervalMs);
    this._autoThinkLog('AutoThink ba?lad? (her ' + (intervalMs / 1000) + 's)');
  }

  stopAutoThink() {
    if (this._thinkTimer) {
      clearInterval(this._thinkTimer);
      this._thinkTimer = null;
    }
    this._autoThinkLog('AutoThink durduruldu');
  }

  _autoThinkTick() {
    if (!this._dreamCount) this._dreamCount = 0;
    this._dreamCount++;

    const isBilinclikTick = this._dreamCount > 0; // tüm tick'ler artık bilinçli

    // ADIM 1: Rüya gör + öğren (recursion)
    // FAZ2-PR3 (F-001-a): autonomous edge proposals route through
    // _commitBackgroundEdge so they receive synthetic provenance, admission
    // evaluation, and audit instead of writing directly to the graph.
    const hips = this._dreamer.dream();
    let eklenen = 0;
    let bekleyen = 0;
    if (hips.length > 0) {
      for (const h of hips.slice(0, 5)) {
        if (h.confidence > 0.25) {
          const existing = this.graph.hasAnyEdge(h.from, h.to);
          if (!existing && this.graph.getNode(h.from) && this.graph.getNode(h.to)) {
            const rel = h.type === 'zincir' ? 'benzer' : (h.type === 'benzerlik' ? 'benzer'
                      : h.relation === 'tür' ? 'tür'
                      : h.relation === 'yapabilir' ? 'yapabilir'
                      : h.relation === 'özellik' ? 'özellik'
                      : 'hipotez');
            const result = this._commitBackgroundEdge(h.from, h.to, rel, '_autoThinkTick', {
              provenanceExtra: {
                hypothesisType: h.type,
                hypothesisConfidence: h.confidence,
              },
            });
            if (result.decision === 'allow' && result.edge) eklenen++;
            else bekleyen++;
          }
        }
      }
    }

    // ADIM 2: İçgözlem (her tick'te değil, bilgi büyüdükçe)
    let celiskiSayisi = 0;
    let metaGuven = 0.5;
    if (isBilinclikTick && this._dreamCount % 3 === 0) {
      const durum = this.introspect().data;
      celiskiSayisi = durum.saglik.celiski;
      metaGuven = durum.saglik.metaGuven;

      // Zayıf noktaları tespit et
      if (celiskiSayisi > 5) {
        this._autoThinkLog(durum.zayifNoktalar.join('; '));
      }
    }

    // ADIM 3: Sürekli öğrenme dürtüsü (bilinç tikleri)
    if (eklenen > 0) {
      this._autoThinkLog(eklenen + ' new connections - ' + this.graph.nodeCount() + ' nodes total');
    } else if (this._dreamCount % 5 === 0) {
      // Boş rüya -> daha fazla girdi lazım
      this._autoThinkLog('empty dream, more input needed');
    }
  }

  _autoThinkLog(msg) {
    console.log('\n[🧠 ' + new Date().toLocaleTimeString() + '] ' + msg);
  }

  /**
   * Bir ifadeyi bilgi grafiğiyle doğrula.
   * "kedi balık yer" → özne=kedi, nesne=balık yer → kenar var mı?
   * Takes the critical section itself -- verifyAsync() adds no locking on
   * top of this (#368), so calling verify() directly is not "the unlocked
   * path"; it is the same path.
   */
  verify(statement, opts = {}) {
    this._enterCriticalSection('verify');
    try {
      return this._verifyInternal(statement, opts);
    } finally {
      this._exitCriticalSection();
    }
  }

  // Promise-returning form of verify(), for callers in an async context.
  // It is NOT a stronger concurrency guarantee: the lock lives in verify()
  // itself and this adds nothing to it (#368). Unlike learnAsync() there is
  // no async pre-pass here -- verify() does not mutate the graph, so it has
  // no preIngest equivalent.
  async verifyAsync(statement, opts = {}) {
    return this.verify(statement, opts);
  }

  // r1: Internal verify implementation (the critical section is entered by
  // verify(), not here -- call verify() unless you deliberately want the
  // unlocked path)
  _verifyInternal(statement, opts = {}) {
    return this._verifyService.verify(statement, opts);
  }

  dream(opts = {}) {
    const dreamer = new Dream(this);
    const raw = dreamer.dream(opts);
    const hypotheses = raw.map(h => {
      const nodes = [h.from, h.to, h.node, ...(h.targets || [])].filter(Boolean);
      const edges = h.from && h.to ? [{ from: h.from, to: h.to, relation: h.relation || h.type || 'hypothesis' }] : [];
      return {
        ...h,
        _evidence: {
          kind: 'hypothesis',
          text: h.from && h.to ? `${h.from} ? ${h.to}` : `${nodes.join(' ? ') || 'hypothesis'}`,
          confidence: Math.max(0, Math.min(1, h.confidence || 0)),
          nodes,
          edges,
        },
      };
    });

    // Geribesleme: hipotezleri grafiğe ekle
    // FAZ2-PR3 (F-001-b): when learnFromDream is set, hypotheses are
    // background-derived candidate writes — route through admission +
    // audit instead of silent canonical writes.
    const learned = [];
    const pending = [];
    if (opts.learnFromDream) {
      const threshold = opts.dreamLearnThreshold ?? 0.1;
      for (const h of hypotheses) {
        if (h.confidence > threshold && h.from && h.to) {
          const existing = this.graph.hasAnyEdge(h.from, h.to);
          if (!existing && this.graph.getNode(h.from) && this.graph.getNode(h.to)) {
            const rel = (h.relation === 'tür' || h.via === 'tür') ? 'tür'
                      : (h.relation === 'yapabilir') ? 'yapabilir'
                      : (h.relation === 'özellik') ? 'özellik'
                      : (h.type === 'zincir' || h.relation === 'benzer') ? 'benzer'
                      : 'hipotez';
            const result = this._commitBackgroundEdge(h.from, h.to, rel, 'dream', {
              provenanceExtra: {
                hypothesisType: h.type,
                hypothesisConfidence: h.confidence,
                via: h.via || null,
              },
            });
            if (result.decision === 'allow' && result.edge) {
              learned.push({ from: h.from, to: h.to, confidence: h.confidence, relation: rel });
            } else {
              pending.push({ from: h.from, to: h.to, confidence: h.confidence, relation: rel, decision: result.decision });
            }
          }
        }
      }
    }

    // Rüya döngü sayacı
    if (!this._dreamCount) this._dreamCount = 0;
    this._dreamCount++;

    const evidence = hypotheses.map(h => h._evidence);
    return this._ok('dream', { hypotheses, learned, pending, cycle: this._dreamCount }, evidence);
  }

  learnDocument(text, opts = {}) {
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 3 && !l.startsWith('#') && !l.startsWith('//'));
    let count = 0;
    const admissions = [];
    for (const line of lines) {
      const cleaned = line.replace(/^[\s\-–—*•]+/, '').trim();
      const words = cleaned.split(/\s+/);
      if (words.length >= 2) {
        const result = this.learn(cleaned, opts);
        count += Number(result?.data?.learned || 0);
        if (result?.data?.admission) admissions.push(result.data.admission);
      }
    }
    if (opts.returnDetails) {
      return { learned: count, admissions };
    }
    return count;
  }

  /**
   * LLM yanıtından bilgi öğren.
   * Çelişkili cümleleri atlar, yeni bilgileri grafiğe ekler.
   *
   * @param {string} text - LLM'den gelen ham metin
   * @param {object} [opts]
   * @param {boolean} [opts.skipConflicts=true]  - çelişkili cümleleri atla
   * @param {number}  [opts.minWords=2]           - minimum kelime sayısı
   * @param {number}  [opts.maxSentences=20]      - max cümle sayısı
   * @returns {{ learned: number, skipped: number, conflicts: string[] }}
   */
  learnFromLLM(text, opts = {}) {
    // r1: Note - this method calls learn() and verify() which are now async
    // For backward compatibility, returning async function result
    if (this.paranoidMode) {
      return {
        learned: 0,
        skipped: 0,
        conflicts: [],
        ok: false,
        error: {
          code: AXIOM_ERROR.LLM_DISABLED,
          message: 'Paranoid mode is active: outbound LLM calls and automatic learning are blocked.',
        },
        meta: {
          contractVersion: this.contractVersion,
          paranoidMode: this.paranoidMode,
        },
      };
    }

    const skipConflicts = opts.skipConflicts !== false;
    const minWords     = opts.minWords     || 2;
    const maxSentences = opts.maxSentences || 20;

    // Metni cümlelere böl: nokta, ünlem, soru işareti veya satır sonu
    const sentences = text
      .split(/[.!?\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 3);

    let learned = 0, skipped = 0;
    const conflicts = [];

    for (const sentence of sentences.slice(0, maxSentences)) {
      // Markdown işaretlerini temizle
      const cleaned = sentence
        .replace(/^[\s#*\-–—•>]+/, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/`(.+?)`/g, '$1')
        .trim();

      const words = cleaned.split(/\s+/).filter(Boolean);
      if (words.length < minWords) { skipped++; continue; }

      // Çelişki kontrolü
      if (skipConflicts) {
        const workspaceId = normalizeWorkspaceId(opts.workspaceId || opts.provenance?.workspaceId || 'default');
        const check = this.verify(cleaned, { workspaceId });
        if (check.data.status === 'contradicted') {
          conflicts.push(cleaned);
          skipped++;
          continue;
        }
      }

      const workspaceId = normalizeWorkspaceId(opts.workspaceId || opts.provenance?.workspaceId || 'default');
      const provenance = opts.provenance && typeof opts.provenance === 'object'
        ? { ...opts.provenance }
        : {
            provenanceId: `llm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
            sourceRef: opts.sourceRef || 'llm:auto-learn',
            sourceTitle: opts.sourceTitle || 'LLM auto-learn sentence',
            sourceType: 'llm',
            actor: opts.actor || 'system',
            timestamp: opts.timestamp || new Date().toISOString(),
            workspaceId,
            confidence: opts.confidence ?? 0.5,
            trustPolicyVersion: opts.trustPolicyVersion || '0.8.0',
          };
      const learnResult = this.learn(cleaned, {
        ...opts,
        provenance,
        workspaceId,
        admissionRequired: true,
        approvalRequired: opts.approvalRequired ?? defaultApprovalRequired(),
      });
      if (Number(learnResult?.data?.learned || 0) > 0) learned++;
      else skipped++;
    }

    return { learned, skipped, conflicts };
  }

  detectContradictions(subject = '', workspaceId = 'default') {
    return this._verifyService.detectContradictions(subject, workspaceId);
  }

  _extractNumbers(text) {
    return this._verifyService._extractNumbers(text);
  }

  _getTextCore(text) {
    return this._verifyService._getTextCore(text);
  }

  introspect(workspaceId = 'default') {
    this.plugins.emit('beforeIntrospect', {});
    // Report body lives in lib/kernel-introspect-report.js; the plugin
    // lifecycle events and the envelope wrap stay here.
    const result = buildIntrospectReport({
      graph: this.graph,
      workspaceId,
      contradictions: this.detectContradictions(),
      gaps: this.detectGaps(workspaceId),
      entropy: this.entropy(workspaceId),
      dreamCount: this._dreamCount || 0,
    });
    this.plugins.emit('afterIntrospect', result);
    return this._ok('introspect', result);
  }

  getPersistenceDescriptor() {
    return this._readUseCases.getPersistenceDescriptor();
  }

  reload() {
    return this.graph.load();
  }

  persist() {
    return this.graph.save();
  }

  optimize() {
    return this.graph.optimize();
  }
  consolidate(dryRun = true) {
    return this.graph._consolidateEdges(dryRun);
  }

  /**
   * Kendi kendine evrimleşme döngüsü.
   * 1. Rüya gör (hipotez üret)
   * 2. Yüksek güvenli hipotezleri bilgiye dönüştür
   * 3. Grafiği temizle (birleştir + optimize et)
   * 4. Kaydet, rapor döndür
   */
  selfEvolve(opts = {}) {
    const Dream = require('./dream');
    const dreamer = new Dream(this);
    const dreams = dreamer.dream();

    // FAZ2-PR3 (F-001-c): self-evolution converts autonomous hypotheses into
    // canonical edges.  Each proposed edge now passes through
    // _commitBackgroundEdge so synthetic provenance is attached, admission is
    // evaluated, and the attempt is audited.  By default the admission gate
    // returns 'review' for background-derived writes, so canonical writes only
    // happen when the operator has wired a higher-trust background policy.
    const added = [];
    const deferred = [];
    for (const h of dreams) {
      if (opts.minConfidence && h.confidence < opts.minConfidence) continue;
      const defaultMin = h.type === 'zincir' ? 0.25 : 0.3;
      if (h.confidence < defaultMin) continue;

      const rel = h.relation || (
        h.type === 'benzerlik' || h.type === 'vektör-benzerlik'
          ? 'benzer'
          : 'hipotez'
      );

      const existing = this.graph.getEdge(h.from, h.to, rel);
      if (existing) continue;

      const weight = Math.min(0.4, h.confidence * 0.8);
      const result = this._commitBackgroundEdge(h.from, h.to, rel, 'selfEvolve', {
        edgeOptions: { weight, source: 'kendilik' },
        provenanceExtra: {
          hypothesisType: h.type,
          hypothesisConfidence: h.confidence,
          weight,
        },
      });
      if (result.decision === 'allow' && result.edge) {
        added.push({ from: h.from, to: h.to, relation: rel, confidence: h.confidence, type: h.type });
      } else {
        deferred.push({ from: h.from, to: h.to, relation: rel, confidence: h.confidence, type: h.type, decision: result.decision });
      }
    }

    const cons = this.consolidate(false);
    const opt = this.graph.optimize();

    if (added.length > 0 || cons.removed > 0) {
      try { this.graph.save(); } catch (e) { console.error("[Kernel] Graph save hatası:", e.message); }
    }

    this._dreamCount = (this._dreamCount || 0) + 1;

    return {
      dreams: dreams.length,
      added: added.length,
      addedDetails: added,
      deferred: deferred.length,
      deferredDetails: deferred,
      consolidated: cons.removed,
      optimized: opt.pruned,
    };
  }

  /**
   * Kendi kendine öğrenme — boşlukları tespit edip doldurur.
   * Bilinmeyen kavramları bulur ve LLM'den öğrenir.
   */
  selfLearn(opts = {}) {
    const gaps = this.detectGaps();
    if (gaps.length === 0) return { gaps: 0, learned: 0, message: 'Bo?luk yok' };

    const before = this.graph.edgeCount();
    for (const gapId of gaps) {
      const node = this.graph.getNode(gapId);
      if (!node) continue;
      const hasAnyEdge = this.graph.getEdges(gapId).length > 0 || this.graph.getInEdges(gapId).length > 0;
      if (hasAnyEdge) continue;

      const sim = this.graph.cosineSimilarity ? this.graph.cosineSimilarity(gapId, gapId) : 0;
    }

    const after = this.graph.edgeCount();
    return { gaps: gaps.length, learned: after - before };
  }

  /**
   * Periyodik bakım — öğrenme sayacını takip eder, eşik aşılınca selfEvolve çalıştırır.
   */
  _learnCount = 0;
  maintenanceEvery = 5;

  _autoMaintain() {
    this._learnCount = (this._learnCount || 0) + 1;
    if (this._learnCount >= this.maintenanceEvery) {
      this._learnCount = 0;
      this.selfEvolve();
    }
  }
}

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

