const Graph = require('./graph');
const Dream = require('./dream');
const fs = require('fs');
const path = require('path');
const PluginManager = require('./plugin');
const createNlp = require('./nlp');
const VerifyService = require('./lib/verify');
const { buildProvenance } = require('./lib/provenance-ingest');
const { evaluateMemoryAdmission } = require('./lib/memory-admission-gate');
const { detectClaimConflict, routeCandidateClaim } = require('./lib/conflict-detector');
const MemoryStore = require('./lib/memory-store');

let RustGraph;
try { RustGraph = require('./rustGraph'); } catch {}
const RUST_BIN = process.env.AXIOM_RUST_BIN || path.join(__dirname, 'axiom-core', 'target', 'x86_64-pc-windows-gnu', 'release', 'axiom-core.exe');
const hasRust = fs.existsSync(RUST_BIN) && typeof RustGraph !== 'undefined';

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
});

function normalizeWorkspaceId(value, fallback = 'default') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

function isPlainObject(value) {
  return Boolean(value) && Object.prototype.toString.call(value) === '[object Object]';
}

class ProvenanceError extends Error {
  constructor(message = 'provenance is required when strictProvenance is true') {
    super(message);
    this.name = 'ProvenanceError';
    this.code = 'PROVENANCE_REQUIRED';
  }
}

class Kernel {
  /**
   * @param {object} [opts]
   * @param {boolean} [opts.noLoad=false] - true ise memory.json y?klenmez (test i?in)
   * @param {string}  [opts.memoryPath]   - ?zel haf?za dosyas? yolu
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
    if (!opts.noLoad) this.graph.load();
    this.paranoidMode = opts.paranoidMode === true || process.env.AXIOM_PARANOID === '1';
    this.contractVersion = CONTRACT_VERSION;
    this.lang = opts.lang || process.env.AXIOM_LANG || 'tr';
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
    
    // r1: RwLock mutex for concurrent access safety
    // Simple lock mechanism (no npm dependencies)
    // Can be disabled with enableConcurrencyLock=false for backward compatibility
    this._enableConcurrencyLock = opts.enableConcurrencyLock !== false;
    this._lockQueue = [];
    this._lockAcquired = false;
    this._lockTimeoutMs = opts.lockTimeoutMs || 5000;

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

  // r1: Acquire lock for critical operations (verify/learn)
  async _acquireLock(timeoutMs = null) {
    if (!this._enableConcurrencyLock) return; // Lock disabled
    
    const timeout = timeoutMs !== null ? timeoutMs : this._lockTimeoutMs;
    const startTime = Date.now();
    
    while (this._lockAcquired && Date.now() - startTime < timeout) {
      await new Promise(resolve => setImmediate(resolve));
    }
    
    if (this._lockAcquired) {
      throw new Error(`Lock acquisition timeout after ${timeout}ms`);
    }
    
    this._lockAcquired = true;
  }

  // r1: Release lock
  _releaseLock() {
    if (!this._enableConcurrencyLock) return; // Lock disabled
    this._lockAcquired = false;
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
      provenanceExtra: {
        sourceType: opts.sourceType || 'plugin',
        sourceRef: opts.sourceRef || '',
        actor: opts.actor || opts.sessionId || 'plugin',
      },
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

  _ok(type, data = null, evidence = [], meta = {}) {
    const stats = this.graph && typeof this.graph.getStats === 'function' ? this.graph.getStats() : {};
    return this._validateResult({
      ok: true,
      type,
      data,
      evidence: this._rankEvidence(Array.isArray(evidence) ? evidence : []),
      error: null,
      meta: {
        contractVersion: this.contractVersion,
        backend: stats.backend || 'unknown',
        paranoidMode: this.paranoidMode,
        ...meta,
      },
    });
  }

  _fail(type, code, message, meta = {}) {
    return this._validateResult({
      ok: false,
      type,
      data: null,
      evidence: [],
      error: { code, message },
      meta: {
        contractVersion: this.contractVersion,
        paranoidMode: this.paranoidMode,
        ...meta,
      },
    });
  }

  _validateResult(result) {
    if (!result || typeof result.ok !== 'boolean') throw new Error('Invalid result: ok must be boolean');
    if (!Array.isArray(result.evidence)) throw new Error('Invalid result: evidence must be array');
    if (result.type === 'verify' && result.data) {
      const statuses = new Set(['dogrulandi', 'celiski', 'bilinmiyor']);
      if (!statuses.has(result.data.status)) throw new Error('Invalid verify status: ' + result.data.status);
      if (typeof result.data.confidence !== 'number' || result.data.confidence < 0 || result.data.confidence > 1) {
        throw new Error('Invalid confidence: must be between 0 and 1');
      }
    }
    return result;
  }

  _edgeRef(edge) {
    return { from: edge.from, to: edge.to, relation: edge.relation };
  }

  _rankEvidence(evidence = []) {
    const seen = new Set();
    return evidence
      .filter(Boolean)
      .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
      .filter(item => {
        const key = `${item.kind || 'evidence'}|${item.text || ''}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  _edgeEvidence(edge, kind = 'direct_edge', confidence) {
    const score = Math.max(0, Math.min(1, confidence ?? edge.confidence ?? edge.weight ?? 0));
    const details = [];
    if (edge.relation) details.push(`relation=${edge.relation}`);
    if (edge.source) details.push(`source=${edge.source}`);
    details.push(`confidence=${score.toFixed(2)}`);
    return {
      kind,
      text: `${edge.from} --[${edge.relation}]--> ${edge.to} (${details.join(', ')})`,
      confidence: score,
      nodes: [edge.from, edge.to],
      edges: [this._edgeRef(edge)],
    };
  }

  _pathEvidence(pathArr, kind = 'path', confidence = 0.5, workspaceId = 'default') {
    const edges = [];
    for (let i = 0; i < pathArr.length - 1; i++) {
      const direct = this.graph.getEdges(pathArr[i], workspaceId).find(e => e.to === pathArr[i + 1]);
      const reverse = this.graph.getInEdges(pathArr[i], workspaceId).find(e => e.from === pathArr[i + 1]);
      const edge = direct || reverse;
      if (edge) edges.push(this._edgeRef(edge));
    }
    return {
      kind,
      text: pathArr.join(' -> '),
      confidence: Math.max(0, Math.min(1, confidence)),
      nodes: [...pathArr],
      edges,
    };
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
      console.error('[Kernel] Audit log hatası:', error.message);
      return null;
    }
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
    const now = new Date().toISOString();
    return {
      provenanceId: `prov_bg_${source}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      timestamp: now,
      source: `background:${source}`,
      sourceType: 'background_inference',
      sourceRef: `kernel.${source}`,
      actor: `kernel-background:${source}`,
      workspaceId,
      trustPolicyVersion: this.contractVersion,
      ...extra,
    };
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
    return opts.admissionRequired === false &&
      typeof opts.admissionBypassReason === 'string' &&
      opts.admissionBypassReason.trim().length > 0;
  }

  _evaluateLearnAdmission(text, opts = {}, provenance = null, workspaceId = 'default') {
    if (this._isLearnAdmissionBypass(opts)) return null;

    const admissionContext = isPlainObject(opts.admissionContext) ? opts.admissionContext : {};
    const createdAt =
      provenance?.timestamp ||
      opts.timestamp ||
      admissionContext.createdAt ||
      admissionContext.timestamp ||
      new Date().toISOString();
    const provenanceId =
      provenance?.provenanceId ||
      opts.provenanceId ||
      admissionContext.provenanceId ||
      `prov_${workspaceId}_${Date.now()}`;
    const actor =
      provenance?.actor ||
      opts.actor ||
      admissionContext.actor ||
      'kernel';
    const agentId =
      opts.agentId ||
      admissionContext.agentId ||
      'kernel';
    const memoryDraftId =
      opts.memoryDraftId ||
      admissionContext.memoryDraftId ||
      `draft_${provenanceId}`;
    const request = {
      ...admissionContext,
      workspaceId,
      actor,
      agentId,
      memoryDraftId,
      provenanceId,
      trustPolicyVersion:
        provenance?.trustPolicyVersion ||
        opts.trustPolicyVersion ||
        admissionContext.trustPolicyVersion ||
        this.contractVersion,
      approvalId: opts.approvalId || admissionContext.approvalId || '',
      approvalStatus: opts.approvalStatus || admissionContext.approvalStatus || '',
      approvalRequired: opts.approvalRequired ?? admissionContext.approvalRequired ?? true,
      reason: opts.admissionReason || admissionContext.reason || 'kernel_learn_write',
      createdAt,
      proposedMemory: {
        content: String(text || ''),
        edges: [{ relation: 'learn', workspaceId }],
        metadata: {
          sourceType: provenance?.sourceType || opts.sourceType || admissionContext.sourceType || '',
          sourceRef: provenance?.sourceRef || opts.sourceRef || admissionContext.sourceRef || '',
          actor,
        },
      },
    };

    const evaluated = evaluateMemoryAdmission(request, {
      approvalRequired: request.approvalRequired,
    });
    if (!evaluated || !evaluated.ok || !evaluated.decision) {
      return {
        outcome: 'review',
        reason: 'memory_admission_evaluation_failed',
        graphWrite: false,
        workspaceId,
      };
    }

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

  // r1: Wrapper with lock for concurrent safety (async version)
  async learnAsync(text, opts = {}) {
    return this.learn(text, opts);
  }

  // Original synchronous learn (backward compatible - no locks)
  // For concurrent access, use learnAsync() instead
  learn(text, opts = {}) {
    const ev = this._runBeforeLearn(text, opts);
    const nextText = ev.text;
    const nextOpts = ev.opts || opts;
    this._enterCriticalSection('learn');
    try {
      return this._learnInternal(nextText, nextOpts, true);
    } finally {
      this._exitCriticalSection();
    }
  }

  // r1: Internal learn implementation
  _learnInternal(text, opts = {}, skipBeforeLearn = false) {
    if (!skipBeforeLearn) {
      const ev = this._runBeforeLearn(text, opts);
      text = ev.text;
      opts = ev.opts || opts;
    }
    const fallbackWorkspaceId = normalizeWorkspaceId(opts.workspaceId || opts.provenance?.workspaceId);
    const hasProvenanceInput =
      Object.prototype.hasOwnProperty.call(opts, 'provenance') ||
      opts.sourceType ||
      opts.sourceRef ||
      opts.sourceTitle ||
      opts.actor ||
      opts.timestamp ||
      opts.workspaceId;
    let provenanceBundle;
    try {
      provenanceBundle = hasProvenanceInput
        ? this._normalizeProvenanceInput(opts.provenance || {}, opts)
        : { provenance: { provenanceId: `auto-${Date.now()}-${Math.random().toString(36).slice(2,8)}`, timestamp: new Date().toISOString(), source: 'learn', actor: 'kernel' }, warnings: [] };
    } catch (error) {
      if (error instanceof ProvenanceError || error.code === 'PROVENANCE_REQUIRED') {
        this._appendAuditEvent({
          eventType: 'REJECT',
          targetType: 'learn',
          targetId: text,
          details: {
            reason: error.code || 'PROVENANCE_REQUIRED',
            message: error.message,
            text,
          },
        }, opts.provenance && typeof opts.provenance === 'object' ? opts.provenance : null, fallbackWorkspaceId);
      }
      throw error;
    }
    const provenance = provenanceBundle.provenance;
    const provenanceWarnings = provenanceBundle.warnings;
    const workspaceId = normalizeWorkspaceId(provenance?.workspaceId || opts.workspaceId || fallbackWorkspaceId);
    const admission = this._evaluateLearnAdmission(text, opts, provenance, workspaceId);

    if (admission && admission.outcome !== 'allow') {
      this._appendAuditEvent({
        eventType: admission.outcome === 'reject' ? 'REJECT' : 'REVIEW',
        targetType: 'learn',
        targetId: text,
        details: {
          text,
          reason: admission.reason,
          admissionOutcome: admission.outcome,
          approvalStatus: admission.approvalStatus,
          ...this._admissionReceiptDetails(admission),
        },
      }, provenance, workspaceId);
      return this._ok('learn', {
        learned: 0,
        skipped: 1,
        conflicts: [],
        alternatives: [],
        provenanceWarnings,
        admission,
      }, [], {
        provenance: provenance || null,
        provenanceWarnings,
        trustPolicyVersion: provenance ? provenance.trustPolicyVersion : undefined,
        admission,
      });
    }

    if (this.strictProvenance && !hasProvenanceInput) {
      this._appendAuditEvent({
        eventType: 'REJECT',
        targetType: 'learn',
        targetId: text,
        details: {
          reason: 'PROVENANCE_REQUIRED',
          message: 'provenance is required when strictProvenance is true',
          text,
        },
      }, opts.provenance && typeof opts.provenance === 'object' ? opts.provenance : null, workspaceId);
      throw new ProvenanceError();
    }

    const parsed = this.extractFacts(text, this.graph.getNodes(workspaceId));
    if (!parsed) return this._ok('learn', {
      learned: 0,
      skipped: 1,
      conflicts: [],
      admission: admission || null,
    }, [], admission ? { admission } : {});

    // KAL?TE KONTROLÃœ: çelişki ve alternatif tespiti
    const conflicts = [];
    const alternatives = [];
    let learned = 0;
    const evidence = [];
    const metadata = this._resolveLearnMetadata(opts);

    for (const { subject, predicate } of parsed) {
      if (typeof subject !== 'string' || !subject.trim() || this.isStopWord(subject)) continue;
      if (typeof predicate !== 'string' || !predicate.trim()) continue;

      const rel = this._parsePredicate(predicate);
      if (!rel || typeof rel !== 'object') continue;
      const { object, relation } = rel;
      if (typeof object !== 'string' || !object.trim() || typeof relation !== 'string' || !relation.trim()) continue;
      if (this.isStopWord(object)) continue;

      const isCopulaNegation = relation === 'değil' && /(?:^|\s)(?:değildir|degildir)\s*$/i.test(predicate.trim());
      const negatedObject = isCopulaNegation ? `${object} [değil]` : object;

        // AYNI ?zne-ili?ki i?in mevcut nesneleri bul
        const existingEdges = this.graph.getEdges(subject, workspaceId).filter(e => e.relation === relation);
        const existingTargets = existingEdges.map(e => e.to);

        // Ã‡EL?ÅK? KONTROLÃœ
        // tür: farkl? anlam ta??yan iki tür ? çelişki
        // değil: ayn? nesne i?in "tür" varsa ? çelişki
        // kistlama (sadece): ayn? ?zne i?in ba?ka yapabilir varsa ? çelişki
        let celiskiBulundu = false;

        if (relation === 'tür') {
          for (const existing of existingTargets) {
            if (existing !== object) {
              const benzerlik = this.contextSimilarity(object, existing, subject);
              if (benzerlik < 0.15) {
                conflicts.push({
                  type: 'alternative',
                  subject,
                  relation: 'tür',
                  current: object,
                  existing,
                  confidence: parseFloat(benzerlik.toFixed(3)),
                });
                celiskiBulundu = true;
              }
            }
          }
        }

        if (relation === 'değil') {
          const turEdges = this.graph.getEdges(subject, workspaceId).filter(e => e.relation === 'tür');
          for (const tur of turEdges) {
            if (tur.to === object) {
              const onceki = tur.weight;
              const oncekiTarget = tur.to;
              tur.weight = 0.2;
              tur.celiski = 'downgraded';
              if (isCopulaNegation) {
                tur.to = negatedObject;
                tur.relation = 'değil';
                tur.negated = true;
                tur.negatedObject = object;
              }
              conflicts.push({
                type: 'negation',
                subject,
                relation: 'değil',
                current: object,
                existing: oncekiTarget,
                message: `"${subject}" "${object} değildir" deniyor (önceden tür:${onceki}) → tür weight düşürüldü`,
                confidence: 0,
              });
              celiskiBulundu = true;
            }
          }
        }

        // KISITLAMA: "sadece x yapar" ? ba?ka yapabilir varsa çelişki
        if (rel.kistlama && relation === 'yapabilir') {
          const digerYapabilir = existingEdges.filter(e => e.relation === 'yapabilir' && e.to !== object);
          for (const dg of digerYapabilir) {
            conflicts.push({
              type: 'restriction',
              subject,
              relation: 'yapabilir',
              current: object,
              existing: dg.to,
              message: `"${subject}" sadece "${object}" yapabilir deniyor ama "${dg.to}" da yapabiliyor`,
              confidence: 0,
            });
            celiskiBulundu = true;
          }
        }

        // ALTERNAT?F: ayn? kavram?n farkl? ifadelerini tespit et
        if (existingTargets.length > 0 && !existingTargets.includes(object)) {
          alternatives.push({
            subject,
            relation,
            current: object,
            existing: existingTargets,
          });
        }

        // Ã–ÄRENME: d?k g?venli alternatifleri de ekle (çelişkiyi ?nlemek i?in farkl? ili?kiyle)
        if (provenance) {
          this.graph.addNode(subject, subject, provenance, { workspaceId });
          this.graph.addNode(object, object, provenance, { workspaceId });
          if (isCopulaNegation) this.graph.addNode(negatedObject, negatedObject, provenance, { workspaceId });
        } else {
          this.graph.addNode(subject, subject, null, { workspaceId });
          this.graph.addNode(object, object, null, { workspaceId });
          if (isCopulaNegation) this.graph.addNode(negatedObject, negatedObject, null, { workspaceId });
        }

        if (celiskiBulundu && (relation === 'tür')) {
          // tür çelişkisi ? benzer olarak kaydet
          const edgeOptions = this._learnEdgeOptions({ source: 'alt', weight: 0.15, evidence: [text] }, metadata, text);
          if (provenance) edgeOptions.provenance = provenance;
          edgeOptions.workspaceId = workspaceId;
          const edge = this.graph.addEdge(
            subject,
            object,
            'benzer',
            edgeOptions
          );
          if (edge) { learned++; evidence.push(this._edgeEvidence(edge)); }
          if (edge) {
            this._appendAuditEvent({
              eventType: 'LEARN',
              targetType: 'edge',
              targetId: `${edge.from}|${edge.relation}|${edge.to}`,
              details: {
                text,
                subject,
                relation: edge.relation,
                object: edge.to,
                conflict: true,
                ...this._admissionReceiptDetails(admission),
              },
            }, provenance, workspaceId);
          }
                } else if (relation === 'değil') {
          const edgeOptions = this._learnEdgeOptions({ source: 'learn', evidence: [text] }, metadata, text);
          if (provenance) edgeOptions.provenance = provenance;
          edgeOptions.workspaceId = workspaceId;
          const edge = this.graph.addEdge(
            subject,
            isCopulaNegation ? negatedObject : object,
            relation,
            edgeOptions
          );
          if (edge) { learned++; evidence.push(this._edgeEvidence(edge)); }
          if (edge) {
            const storedObject = isCopulaNegation ? negatedObject : object;
            const hadExisting = existingEdges.some(e => e.to === storedObject && e.relation === relation);
            this._appendAuditEvent({
              eventType: hadExisting ? 'REAFFIRMED' : 'LEARN',
              targetType: 'edge',
              targetId: `${edge.from}|${edge.relation}|${edge.to}`,
              details: {
                text,
                subject,
                relation,
                object: storedObject,
                originalObject: object,
                conflict: celiskiBulundu,
                reaffirmed: hadExisting,
                ...this._admissionReceiptDetails(admission),
              },
            }, provenance, workspaceId);
          }
        } else if (celiskiBulundu) {
          // kistlama ? d?k weight ile kaydet
          const edgeOptions = this._learnEdgeOptions({ source: 'learn', weight: 0.2, evidence: [text] }, metadata, text);
          if (provenance) edgeOptions.provenance = provenance;
          edgeOptions.workspaceId = workspaceId;
          if (['CAUSES', 'PREVENTS', 'DEPENDS_ON', 'ENABLES'].includes(relation)) edgeOptions.strength = edgeOptions.strength ?? 0.8;
          const edge = this.graph.addEdge(
            subject,
            object,
            relation,
            edgeOptions
          );
          if (rel.kistlama && edge) edge.kistlama = true;
          if (edge) { learned++; evidence.push(this._edgeEvidence(edge)); }
          if (edge) {
            const hadExisting = existingEdges.some(e => e.to === object && e.relation === relation);
            this._appendAuditEvent({
              eventType: hadExisting ? 'REAFFIRMED' : 'LEARN',
              targetType: 'edge',
              targetId: `${edge.from}|${edge.relation}|${edge.to}`,
              details: {
                text,
                subject,
                relation,
                object,
                conflict: true,
                reaffirmed: hadExisting,
                ...this._admissionReceiptDetails(admission),
              },
            }, provenance, workspaceId);
          }
        } else {
          // Normal ?ÄŸrenme
          const edgeOptions = this._learnEdgeOptions({ source: 'learn', evidence: [text] }, metadata, text);
          if (provenance) edgeOptions.provenance = provenance;
          edgeOptions.workspaceId = workspaceId;
          if (['CAUSES', 'PREVENTS', 'DEPENDS_ON', 'ENABLES'].includes(relation)) edgeOptions.strength = edgeOptions.strength ?? 0.8;
          const hadExisting = existingEdges.some(e => e.to === object && e.relation === relation);
          const edge = this.graph.addEdge(
            subject,
            object,
            relation,
            edgeOptions
          );
          this.graph.addTag(subject, object, 0.3, workspaceId);
          // FAZ2-PR3: derived cross-link writes inherit parent learn admission +
          // provenance.  This is NOT a background bypass — the parent admission
          // already evaluated this user-initiated write.
          this._crossLink(subject, object, relation, workspaceId, {
            parentAdmissionAllowed: true,
            parentProvenance: provenance,
            derivedSource: 'learn',
          });
          learned++;
          if (edge) evidence.push(this._edgeEvidence(edge));
          if (edge) {
            this._appendAuditEvent({
              eventType: hadExisting ? 'REAFFIRMED' : 'LEARN',
              targetType: 'edge',
              targetId: `${edge.from}|${edge.relation}|${edge.to}`,
              details: {
                text,
                subject,
                relation,
                object,
                reaffirmed: hadExisting,
                ...this._admissionReceiptDetails(admission),
              },
            }, provenance, workspaceId);
          }
        }
      }

    this.plugins.emit('afterLearn', { text, conflicts, alternatives, opts: { ...metadata, workspaceId } });

    if (this._rust) {
      this._rust.learn(text).catch((e) => { console.error("[Kernel] Rust learn hatası:", e?.message || e); });
    }

    if (learned > 0) {
      try { this.graph.save(); } catch (e) { console.error("[Kernel] Graph save hatası:", e.message); }
      if (typeof setImmediate !== 'undefined') setImmediate(() => this._autoMaintain());
    }

    return this._ok('learn', {
      learned,
      skipped: parsed.length - learned,
      conflicts,
      alternatives,
      provenanceWarnings,
      admission: admission || null,
    }, evidence, {
      provenance: provenance || null,
      provenanceWarnings,
      trustPolicyVersion: provenance ? provenance.trustPolicyVersion : undefined,
      admission: admission || null,
    });
  }

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
    return routeCandidateClaim(this, input, opts);
  }

  _normalizeExplicitRelationObject(rawObject, opts = {}) {
    const text = String(rawObject || '').trim();
    if (!text) return '';

    const words = text.split(/\s+/).filter(Boolean);
    if (words.length === 0) return '';

    const last = words[words.length - 1];
    let cleaned = last;
    if (opts.trimCaseSuffixes !== false) {
      cleaned = cleaned.replace(/(y[iıuü]|[iıuü]|[ae])$/i, '');
    }
    if (!cleaned) cleaned = last;
    if (opts.trimCaseSuffixes !== false) {
      cleaned = cleaned.replace(/([gGdDbB])$/, (match) => ({
        g: 'k',
        G: 'K',
        d: 't',
        D: 'T',
        b: 'p',
        B: 'P',
      }[match] || match));
    }
    words[words.length - 1] = this.normalizeWord(cleaned);
    return words.join(' ').trim();
  }

  _parseExplicitRelationPredicate(predicate) {
    const normalized = String(predicate || '').trim();
    if (!normalized) return null;

    const patterns = [
      { relation: 'CAUSES', mode: 'suffix', trimCaseSuffixes: true, marker: /^(.*?)\s+(neden olur|yol acar|yol açar|sebep olur|tetikler|yapar)$/i },
      { relation: 'CAUSES', mode: 'prefix', trimCaseSuffixes: false, marker: /^(causes|cause|leads to|triggers)\s+(.+)$/i },
      { relation: 'PREVENTS', mode: 'suffix', trimCaseSuffixes: true, marker: /^(.*?)\s+(onler|önler|engeller|durdurur|onune gecer|önüne geçer)$/i },
      { relation: 'PREVENTS', mode: 'prefix', trimCaseSuffixes: false, marker: /^(prevents|prevent|blocks|stops)\s+(.+)$/i },
      { relation: 'DEPENDS_ON', mode: 'suffix', trimCaseSuffixes: true, marker: /^(.*?)\s+(bagli|baglı|bağlı|baglidir|baglıdır|bağlıdır|gerektirir|dayanir|dayanır|olmadan)$/i },
      { relation: 'DEPENDS_ON', mode: 'prefix', trimCaseSuffixes: false, marker: /^(requires|depends on)\s+(.+)$/i },
      { relation: 'ENABLES', mode: 'suffix', trimCaseSuffixes: true, marker: /^(.*?)\s+(saglar|sağlar|mumkun kilar|mümkün kılar|olanak verir|etkinlestirir|etkinleştirir)$/i },
      { relation: 'ENABLES', mode: 'prefix', trimCaseSuffixes: false, marker: /^(enables|enable)\s+(.+)$/i },
    ];

    for (const pattern of patterns) {
      const match = normalized.match(pattern.marker);
      if (!match) continue;
      const objectText = pattern.mode === 'prefix' ? match[2] : match[1];
      const object = this._normalizeExplicitRelationObject(objectText, {
        trimCaseSuffixes: pattern.trimCaseSuffixes !== false,
      });
      if (!object) continue;
      return { object, relation: pattern.relation };
    }

    return null;
  }

  _parsePredicate(predicate) {
    // "bir" gibi belirsiz artikelleri temizle
    predicate = predicate.replace(/^bir\s+/, '').trim();

    // KISITLAMA: "sadece x yapar" ? k?s?tlama i?areti
    const kistlama = predicate.match(/^(sadece|yaln?zca|s?rf|ancak)\s+(.+)/i);
    if (kistlama) {
      // K?s?tl? hali parse et, k?s?tlama bilgisini object'e g?m
      const inner = kistlama[2];
      const parsed = this._parsePredicate(inner);
      if (parsed) {
        parsed.kistlama = true;
        parsed.object = inner;
        return parsed;
      }
    }

    // -değil/-değildir ? olumsuzluk
    // "fark?ndal?k değildir" ? değil ili?kisi
    const degilMatch = predicate.match(/^(.+?)\s+değildir$/i);
    if (degilMatch) {
      return { object: degilMatch[1].trim(), relation: 'değil' };
    }
    // tek kelime "değildir" biti?ik: "fark?ndal?kdeğildir"
    const degilSuffix = /^(.+?)değildir$/i;
    const dMatch = predicate.match(degilSuffix);
    if (dMatch && dMatch[1].trim()) {
      return { object: dMatch[1].trim(), relation: 'değil' };
    }

    // -mez/-maz olumsuz fiil: "hissetmez", "anlamaz", "bilmez" ? değil
    // "duyguyu hissetmez" gibi ?ok kelimeli i?in son kelimeyi kontrol et
    const negVerbMatch = predicate.match(/^(.+?)\s+(.+)(mez|maz)$/i);
    if (negVerbMatch) {
      const verb = negVerbMatch[2] + negVerbMatch[3];
      return { object: (negVerbMatch[1] + ' ' + verb).trim(), relation: 'değil' };
    }
    // tek kelimeli: "hissetmez"
    const negSingle = predicate.match(/^(.+?)(mez|maz)$/i);
    if (negSingle && predicate.indexOf(' ') === -1) {
      return { object: predicate, relation: 'değil' };
    }

    // Explicit DEPENDS_ON check before -dır suffix catch-all.
    // Prevents "baglidir" / "bağlıdır" / "bagli" / "bağlı" from
    // being swallowed by the generic -dir/-dır tür pattern.
    const earlyDepends = this._parseExplicitRelationPredicate(predicate);
    if (earlyDepends && earlyDepends.relation === 'DEPENDS_ON') {
      return earlyDepends;
    }
    // -dır/-dir/-dur/-dır/-tür/-tir/-tur/-tür ? tür ili?kisi
    const tirSuffix = /(dır|dir|dur|dır|tür|tir|tur|tür)$/i;
    if (tirSuffix.test(predicate)) {
      const stem = this.normalizeWord(predicate.replace(tirSuffix, ''));
      return { object: stem, relation: 'tür' };
    }

    // -dır/-dir ekli ?ok kelimeli y?klem: "doÄŸru d?nme y?ntemidir"
    const tirMulti = /^(.+?)(dır|dir|dur|dır|tür|tir|tur|tür)$/i;
    const mMatch = predicate.match(tirMulti);
    if (mMatch && mMatch[1].includes(' ')) {
      return { object: mMatch[1].trim(), relation: 'tür' };
    }

    const explicitRelation = this._parseExplicitRelationPredicate(predicate);
    if (explicitRelation) {
      return explicitRelation;
    }

    // Fiil ekleri ? yapabilir ili?kisi
    const verbSuffix = /(ar|er|ır|ir|ur|ür|yor|acak|ecek|mak|mek)$/i;
if (verbSuffix.test(predicate)) {
      return { object: predicate, relation: 'yapabilir' };
    }

    // -r ile biten k?sa fiiller
    if (/r$/i.test(predicate) && predicate.length > 2) {
      return { object: predicate, relation: 'yapabilir' };
    }

    // Ã‡ok kelimeli y?klem ? özellik
    return { object: predicate, relation: 'özellik' };
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
    const ev = this.plugins.emit('beforeAsk', { question });
    question = ev.question;
    const workspaceId = 'default';

    const raw = question.toLowerCase().trim();
    const cleaned = raw
      .replace(/\b(nedir|kimdir|nas\u0131l|nerede|nereden|nereye|ka\u00e7|hangi)\b/gi, '')
      .trim();

    // YARDIM: ?ah?s eklerini k?ke indirge
    const _kokeIndirge = (s) => {
      let kok = s
        .replace(/mezsem$/, 'me')
        .replace(/mazsam$/, 'ma')
        .replace(/sem$/, '')
        .replace(/sam$/, '')
        .replace(/meliyim$/, 'me')
        .replace(/mal\u0131y\u0131m$/, 'ma')
        .replace(/yim$/, '')
        .replace(/y\u0131m$/, '')
        .replace(/yum$/, '')
        .replace(/y\u00fcm$/, '')
        .replace(/m$/, '')
        .replace(/im$/, '')
        .replace(/s\u0131n$/, '')
        .replace(/sin$/, '')
        .replace(/sun$/, '')
        .replace(/s\u00fcn$/, '')
        .replace(/yorsun$/, '')
        .replace(/yor$/, '');
      // "s?rekli ?ÄŸrenmeliyim" ? "s?rekli ?ÄŸrenme"
      if (kok.endsWith('meliyim')) kok = kok.slice(0, -7);
      return kok.trim();
    };

    // YARDIM: ?zneyi bul (ben kipi varsa axiom'a y?nlendir)
    const _ozneBul = (s) => {
      const parts = s.split(/\s+/).filter(Boolean);
      if (parts.length === 0) return { subject: 'axiom', verb: '' };
      const ilk = parts[0];
      const normalized = this.normalizeWord(ilk);
      // ?lk kelime grafikte var m??
      if (this.graph.getNode(normalized)) {
        return { subject: normalized, verb: parts.slice(1).join(' ') };
      }
      // Åah?s eki var m?? (?ÄŸrenmezsem, ?ÄŸrenmeliyim, bilmiyorum, yapabilirim...)
      const fiilKok = _kokeIndirge(ilk);
      const normKok = this.normalizeWord(fiilKok);
      if (this.graph.getNode(normKok)) {
        return { subject: 'axiom', verb: normKok };
      }
      // Son kelimeye bak (s?rekli ?ÄŸrenmeliyim ? "s?rekli" değil "?ÄŸrenme")
      if (parts.length > 1) {
        const son = parts[parts.length - 1];
        const sonKok = _kokeIndirge(son);
        const normSon = this.normalizeWord(sonKok);
        // "s?rekli"yi s?fat olarak ata
        const sifati = parts.slice(0, -1).join(' ') + ' ' + sonKok;
        if (this.graph.getNode(normSon)) {
          return { subject: 'axiom', verb: sifati, sifat: parts.slice(0, -1).join(' ') };
        }
        // Hi?biri yoksa axiom dene
        return { subject: 'axiom', verb: s };
      }
      return { subject: normalized, verb: '' };
    };

    // PATTERN 1: Neden/ni?in/niye sorusu ? reason() kullan
    if (/^(neden|ni?in|niye)\b/.test(raw)) {
      const action = raw.replace(/^(neden|ni?in|niye)\s+/, '');
      const { subject } = _ozneBul(action);
      const subj = this.normalizeWord(subject);
      return this.reason(subj || 'axiom');
    }

    // PATTERN 2: "ne olur" / "olursa" sorusu ? forward chain
    if (/ne olur/.test(raw) || /\w+sa\b/.test(raw) || /\w+se\b/.test(raw)) {
      const action = raw.replace(/\s+ne olur.*$/, '').replace(/\s+olursa.*$/, '').trim();
      const { subject, verb } = _ozneBul(action);
      const subj = this.graph.getNode(verb && this.normalizeWord(verb)) ? this.normalizeWord(verb) : this.normalizeWord(subject);
      if (this.graph.getNode(subj)) {
        return this.reason(subj);
      }
    }

    const parts = cleaned.split(/\s+/).filter(Boolean);
    const { subject: detected } = _ozneBul(parts[0] || '');
    const subject = detected;
    const node = this.graph.getNode(subject);

    // EÄŸer ?zne grafikte yoksa ama ?ah?s eki varsa, axiom'a y?nlendir
    const finalSubject = node ? subject : 'axiom';
    const finalNode = this.graph.getNode(finalSubject);

    if (!finalNode) {
      return this._ok('ask', { answer: 'Bilmiyorum', subject: finalSubject, unknown: true }, []);
    }

    const edges = this.graph.getEdges(finalSubject);
    if (edges.length === 0) {
      return this._ok('ask', { answer: 'Bilmiyorum', subject: finalSubject, unknown: true }, []);
    }

    // KISITLAMA: sadece x yapar ? filter yapabilir edges
    const kistlamaVar = edges.some(e => e.kistlama && e.relation === 'yapabilir');
    const allowedYapabilir = kistlamaVar
      ? new Set(edges.filter(e => e.kistlama && e.relation === 'yapabilir').map(e => e.to))
      : null;

    const sorted = [...edges].sort((a, b) => b.weight - a.weight);
    const evidence = [];
    const results = [];

    for (const edge of sorted) {
      if (kistlamaVar && edge.relation === 'yapabilir' && !allowedYapabilir.has(edge.to)) continue;
      evidence.push(this._edgeEvidence(edge));
      if (edge.relation === 'tür') {
        if (!results.includes(edge.to)) results.push(edge.to);
        const transitive = this._walkTransitive(edge.to, [], 2);
        for (const t of transitive) {
          if (!results.includes(t)) results.push(t);
        }
      } else if (edge.relation === 'yapabilir') {
        if (!results.includes(edge.to)) results.push(edge.to);
      } else if (!results.includes(edge.to)) {
        results.push(edge.to);
      }
    }

    // Alternatif ??z?m ?nerileri
    const altResult = this.alternatives(finalSubject, 2, workspaceId);
    const altPaths = altResult.data.paths || [];
    const altText = altPaths.length > 1
      ? `\n  alternatif: ${altPaths.map(p => `[${p.type}] ${p.to}`).join(', ')}`
      : '';

    const answer = results.length === 0 ? 'Bilmiyorum' : `${finalSubject} ${results.join(', ')}${altText}`;
    this.plugins.emit('afterAsk', { question, answer, alternatives: altPaths.length });
    return this._ok('ask', { answer, subject: finalSubject, unknown: false, alternatives: altPaths.length }, evidence);
  }

  _walkTransitive(nodeId, visited, depth) {
    if (depth <= 0 || visited.includes(nodeId)) return [];
    visited.push(nodeId);
    const edges = this.graph.getEdges(nodeId);
    const results = [];
    for (const e of edges) {
      if (e.relation === 'tür' && !visited.includes(e.to)) {
        results.push(e.to);
        results.push(...this._walkTransitive(e.to, visited, depth - 1));
      }
    }
    return results;
  }

  alternatives(subject, maxPaths = 3, workspaceId = 'default') {
    const normalized = this.normalizeWord(subject);
    const node = this.graph.getNode(normalized, workspaceId);
    if (!node) {
      return this._ok('alternatives', { subject: normalized, answer: 'Bilmiyorum', paths: [] }, []);
    }

    // 1. DoÄŸrudan kenarlardan alternatif gruplar? olu?tur
    const edges = this.graph.getEdges(normalized, workspaceId);
    const groups = { 'tür': [], yapabilir: [], 'özellik': [], benzer: [], hipotez: [] };
    for (const e of edges) {
      const g = groups[e.relation];
      if (g) g.push(e.to);
    }

    // 2. En y?ksek g?venli hedefleri se?, her gruptan bir tane al
    const paths = [];
    const usedNodes = new Set([normalized]);

    // ?li?ki ?nceliÄŸi: tür > yapabilir > özellik > benzer > hipotez
    const relOrder = ['tür', 'yapabilir', 'özellik', 'benzer', 'hipotez'];

    for (const rel of relOrder) {
      if (paths.length >= maxPaths) break;
      const targets = groups[rel] || [];
      if (targets.length === 0) continue;

      // G?vene g?re s?rala (y?ksekten d?ÄŸe)
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

    // 3. Alternatif ??z?m olarak deÄŸerlendir
    let answer = normalized + ' i?in alternatif ??z?mler:\n';
    for (const p of paths) {
      answer += `  [${p.type}] ${p.from} ? ${p.to}`;
      if (p.chain.length > 0) {
        answer += ` ? ${p.chain.map(c => c.node + '(' + c.rel + ')').join(', ')}`;
      }
      answer += ` (g?ven: ${p.confidence.toFixed(2)})\n`;
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
    const allNodes = Object.values(this.graph.getNodes(workspaceId));
    if (allNodes.length === 0) return 0;
    let totalWeight = 0;
    const weights = [];
    for (const node of allNodes) {
      const edges = this.graph.getEdges(node.id, workspaceId);
      for (const e of edges) {
        weights.push(e.weight);
        totalWeight += e.weight;
      }
    }
    if (totalWeight === 0) return 0;
    let s = 0;
    for (const w of weights) {
      const p = w / totalWeight;
      s -= p * Math.log(p);
    }
    return s;
  }

  detectGaps(workspaceId = 'default') {
    const allNodes = Object.values(this.graph.getNodes(workspaceId));
    const gaps = [];
    for (const node of allNodes) {
      const edges = this.graph.getEdges(node.id, workspaceId);
      if (edges.length === 0) {
        gaps.push(node.id);
      }
    }
    return gaps;
  }

  reason(subject, workspaceId = 'default') {
    const normalized = this.normalizeWord(subject);
    const node = this.graph.getNode(normalized, workspaceId);
    if (!node) {
      return this._ok('reason', {
        subject: normalized,
        answer: 'Bilmiyorum',
        forward: [],
        backward: [],
        cycles: [],
      }, []);
    }

    const ileri = this._forwardChain(normalized, [], new Set(), 4, workspaceId);
    const geri = this._backwardChain(normalized, [], new Set(), 4, workspaceId);
    const cycle = this._detectCycle(normalized, new Set(), [], workspaceId);
    const evidence = [
      ...ileri.map(edge => this._edgeEvidence(edge, 'path', 0.5)),
      ...geri.map(edge => this._edgeEvidence(edge, 'path', 0.5)),
    ];

    let answer = normalized + ':';
    if (ileri.length > 0) answer += '\n  neden olur: ' + ileri.map(e => e.to + ' [' + e.relation + ']').join(', ');
    if (geri.length > 0) answer += '\n  nedeni: ' + geri.map(e => e.from + ' [' + e.relation + ']').join(', ');
    if (cycle) {
      answer += '\n  ? döngü tespit edildi: ' + cycle.join(' ? ');
      evidence.push(this._pathEvidence(cycle, 'path', 0.4, workspaceId));
      const nedenOnce = this._resolveCycleOrder(cycle, workspaceId);
      if (nedenOnce) answer += '\n  ? ilk neden: ' + nedenOnce;
    }

    return this._ok('reason', {
      subject: normalized,
      answer: answer || 'Bilmiyorum',
      forward: ileri.map(edge => this._edgeRef(edge)),
      backward: geri.map(edge => this._edgeRef(edge)),
      cycles: cycle ? [cycle] : [],
    }, evidence);
  }

  compare(a, b, workspaceId = 'default') {
    const na = this.graph.getNode(this.normalizeWord(a), workspaceId);
    const nb = this.graph.getNode(this.normalizeWord(b), workspaceId);
    if (!na || !nb) {
      return this._ok('compare', {
        a: this.normalizeWord(a),
        b: this.normalizeWord(b),
        answer: 'Bilmiyorum',
        common: [],
        onlyA: [],
        onlyB: [],
        paths: [],
      }, []);
    }

    const aN = na.id;
    const bN = nb.id;
    const aEdges = this.graph.getEdges(aN, workspaceId);
    const bEdges = this.graph.getEdges(bN, workspaceId);
    const aSet = new Set(aEdges.map(e => e.to + '|' + e.relation));
    const bSet = new Set(bEdges.map(e => e.to + '|' + e.relation));

    const ortak = aEdges.filter(e => bSet.has(e.to + '|' + e.relation));
    const aFark = aEdges.filter(e => !bSet.has(e.to + '|' + e.relation));
    const bFark = bEdges.filter(e => !aSet.has(e.to + '|' + e.relation));
    const foundPath = this._findPath(aN, bN, new Set(), [], 5, workspaceId);

    const evidence = [
      ...ortak.map(edge => this._edgeEvidence(edge)),
      ...aFark.map(edge => this._edgeEvidence(edge, 'partial_match', 0.35)),
      ...bFark.map(edge => this._edgeEvidence(edge, 'partial_match', 0.35)),
    ];
    if (foundPath) evidence.push(this._pathEvidence(foundPath, 'path', 0.5, workspaceId));

    let answer = '?? ' + aN + ' vs ' + bN + ':';
    if (ortak.length > 0) answer += '\n  ortak: ' + ortak.map(e => e.to + ' [' + e.relation + ']').join(', ');
    if (aFark.length > 0) answer += '\n  sadece ' + aN + ': ' + aFark.map(e => e.to + ' [' + e.relation + ']').join(', ');
    if (bFark.length > 0) answer += '\n  sadece ' + bN + ': ' + bFark.map(e => e.to + ' [' + e.relation + ']').join(', ');
    if (foundPath) answer += '\n  ba?lant?: ' + foundPath.join(' ? ');

    return this._ok('compare', {
      a: aN,
      b: bN,
      answer,
      common: ortak.map(edge => this._edgeRef(edge)),
      onlyA: aFark.map(edge => this._edgeRef(edge)),
      onlyB: bFark.map(edge => this._edgeRef(edge)),
      paths: foundPath ? [foundPath] : [],
    }, evidence);
  }

  _parseNumericComparison(text) {
    return this._verifyService._parseNumericComparison(text);
  }

  _forwardChain(id, chain, visited, depth, workspaceId = 'default') {
    if (depth <= 0 || visited.has(id)) return chain;
    visited.add(id);
    const edges = this.graph.getEdges(id, workspaceId);
    for (const e of edges) {
      if (!visited.has(e.to) && !chain.some(c => c.to === e.to)) {
        chain.push(e);
        this._forwardChain(e.to, chain, visited, depth - 1, workspaceId);
      }
    }
    return chain;
  }

  _backwardChain(id, chain, visited, depth, workspaceId = 'default') {
    if (depth <= 0 || visited.has(id)) return chain;
    visited.add(id);
    const inEdges = this.graph.getInEdges(id, workspaceId);
    for (const e of inEdges) {
      if (!visited.has(e.from) && !chain.some(c => c.from === e.from)) {
        chain.push(e);
        this._backwardChain(e.from, chain, visited, depth - 1, workspaceId);
      }
    }
    return chain;
  }

  _detectCycle(start, visited, pathArr, workspaceId = 'default') {
    if (visited.has(start)) {
      const idx = pathArr.indexOf(start);
      if (idx >= 0) return pathArr.slice(idx).concat(start);
      return null;
    }
    visited.add(start);
    pathArr.push(start);
    const edges = this.graph.getEdges(start, workspaceId);
    for (const e of edges) {
      const result = this._detectCycle(e.to, visited, [...pathArr], workspaceId);
      if (result) return result;
    }
    const inEdges = this.graph.getInEdges(start, workspaceId);
    for (const e of inEdges) {
      if (!visited.has(e.from)) {
        const result = this._detectCycle(e.from, visited, [...pathArr], workspaceId);
        if (result) return result;
      }
    }
    return null;
  }

  _resolveCycleOrder(cycle, workspaceId = 'default') {
    const giren = new Set();
    const cikan = new Set();
    for (let i = 0; i < cycle.length - 1; i++) {
      const edges = this.graph.getEdges(cycle[i], workspaceId);
      for (const e of edges) {
        if (e.to === cycle[i + 1] && e.relation === 'tür') {
          cikan.add(cycle[i]);
          giren.add(cycle[i + 1]);
        }
      }
    }
    for (const n of cycle) {
      if (cikan.has(n) && !giren.has(n)) return n + ' (temel tür)';
    }
    return null;
  }

  _findPath(from, to, visited, pathArr, depth, workspaceId = 'default') {
    return this._findPathWithTimeout(from, to, 100, workspaceId, depth).path;
  }

  // r3: findPathWithTimeout - DFS path finding with timeout protection
  // Prevents infinite recursion or excessive backtracking in cyclic graphs
  _findPathWithTimeout(from, to, timeoutMs = 100, workspaceId = 'default', maxDepth = 5) {
    const startTime = Date.now();
    const visited = new Set();
    const pathArr = [];
    let stoppedReason = null;
    
    const search = (current, depth) => {
      // r3: Check timeout on each recursion step
      if (Date.now() - startTime > timeoutMs) {
        stoppedReason = 'timeout';
        return null; // Timeout - abort search
      }
      
      if (depth <= 0) {
        stoppedReason = stoppedReason || 'maxDepth';
        return null;
      }

      if (visited.has(current)) {
        stoppedReason = stoppedReason || 'cycle';
        return null;
      }
      
      visited.add(current);
      pathArr.push(current);
      
      if (current === to) return [...pathArr];
      
      // Forward search
      const edges = this.graph.getEdges(current, workspaceId);
      for (const e of edges) {
        const result = search(e.to, depth - 1);
        if (result) return result;
      }
      
      // Backward search
      const inEdges = this.graph.getInEdges(current, workspaceId);
      for (const e of inEdges) {
        const result = search(e.from, depth - 1);
        if (result) return result;
      }
      
      pathArr.pop();
      return null;
    };
    
    const path = search(from, maxDepth);
    if (!path && !stoppedReason) stoppedReason = 'not_found';
    return {
      path,
      stoppedReason,
      maxDepth,
      timeoutMs,
      workspaceId,
      visitedCount: visited.size,
    };
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

    const isBilinclikTick = this._dreamCount > 0; // t?m tick'ler art?k bilin?li

    // ADIM 1: R?ya g?r + ?ÄŸren (recursion)
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

    // ADIM 2: ??g?zlem (her tick'te değil, bilgi b?y?d?k?e)
    let celiskiSayisi = 0;
    let metaGuven = 0.5;
    if (isBilinclikTick && this._dreamCount % 3 === 0) {
      const durum = this.introspect().data;
      celiskiSayisi = durum.saglik.celiski;
      metaGuven = durum.saglik.metaGuven;

      // Zay?f noktalar? tespit et
      if (celiskiSayisi > 5) {
        this._autoThinkLog(durum.zayifNoktalar.join('; '));
      }
    }

    // ADIM 3: S?rekli ?ÄŸrenme dırt?s? (bilin? tikleri)
    if (eklenen > 0) {
      this._autoThinkLog(eklenen + ' yeni baÄŸlant? - toplam ' + Object.keys(this.graph._nodes).length + ' d?ÄŸ?m');
    } else if (this._dreamCount % 5 === 0) {
      // Bo? r?ya -> daha fazla girdi laz?m
      this._autoThinkLog('bo? r?ya, daha fazla bilgi laz?m');
    }
  }

  _autoThinkLog(msg) {
    console.log('\n[ğŸ§  ' + new Date().toLocaleTimeString() + '] ' + msg);
  }

  /**
   * Bir ifadeyi bilgi grafiÄŸiyle doÄŸrula.
   * "kedi bal?k yer" ? ?zne=kedi, nesne=bal?k yer ? kenar var m??
   * r1: Use verifyAsync() for concurrent safety with locks
   */
  verify(statement, opts = {}) {
    this._enterCriticalSection('verify');
    try {
      return this._verifyInternal(statement, opts);
    } finally {
      this._exitCriticalSection();
    }
  }

  // r1: Async wrapper with lock for concurrent safety
  async verifyAsync(statement, opts = {}) {
    return this.verify(statement, opts);
  }

  // r1: Internal verify implementation (protected by lock if verifyAsync is called)
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

    // Geribesleme: hipotezleri grafiÄŸe ekle
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

    // R?ya döngü sayac?
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
      const cleaned = line.replace(/^[\s-â€“â€”*â€¢]+/, '').trim();
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
   * LLM yan?t?ndan bilgi ?ÄŸren.
   * Ã‡eli?kili c?mleleri atlar, yeni bilgileri grafiÄŸe ekler.
   *
   * @param {string} text - LLM'den gelen ham metin
   * @param {object} [opts]
   * @param {boolean} [opts.skipConflicts=true]  - çelişkili c?mleleri atla
   * @param {number}  [opts.minWords=2]           - minimum kelime say?s?
   * @param {number}  [opts.maxSentences=20]      - max c?mle say?s?
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
          message: 'Paranoid mode aktif: d?? LLM ?aÄŸr?lar? ve otomatik ?ÄŸrenme engellendi.',
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

    // Metni c?mlelere b?l: nokta, ?nlem, soru i?areti veya satür sonu
    const sentences = text
      .split(/[.!?\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 3);

    let learned = 0, skipped = 0;
    const conflicts = [];

    for (const sentence of sentences.slice(0, maxSentences)) {
      // Markdown i?aretlerini temizle
      const cleaned = sentence
        .replace(/^[\s#*\-â€“â€”â€¢>]+/, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/`(.+?)`/g, '$1')
        .trim();

      const words = cleaned.split(/\s+/).filter(Boolean);
      if (words.length < minWords) { skipped++; continue; }

      // Ã‡eli?ki kontrol?
      if (skipConflicts) {
        const workspaceId = normalizeWorkspaceId(opts.workspaceId || opts.provenance?.workspaceId || 'default');
        const check = this.verify(cleaned, { workspaceId });
        if (check.data.status === 'celiski') {
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
        approvalRequired: opts.approvalRequired ?? true,
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
    const allNodes = Object.values(this.graph.getNodes(workspaceId));
    const allEdges = allNodes.flatMap(n => this.graph.getEdges(n.id, workspaceId));
    const inEdges  = allNodes.flatMap(n => this.graph.getInEdges(n.id, workspaceId));

    // Temel istatistikler
    const nodeCount = allNodes.length;
    const edgeCount = allEdges.length;
    const typeEdges = allEdges.filter(e => e.relation === 'tür').length;
    const canEdges  = allEdges.filter(e => e.relation === 'yapabilir').length;
    const ozellikEdges = allEdges.filter(e => e.relation === 'özellik').length;
    const benzerEdges  = allEdges.filter(e => e.relation === 'benzer').length;
    const hipotezEdges = allEdges.filter(e => e.relation === 'hipotez').length;

    // Yal?t?lm?? d?ÄŸ?mler
    const yalitilmis = allNodes.filter(n => {
      const out = this.graph.getEdges(n.id, workspaceId);
      const inn = this.graph.getInEdges(n.id, workspaceId);
      return out.length === 0 && inn.length === 0;
    }).map(n => n.id);

    // Ã‡eli?kiler
    const celiskiler = this.detectContradictions();

    // Bo?luklar (hi? kenar? olmayan)
    const bosluklar = this.detectGaps(workspaceId);

    // Kenar aÄŸ?rl?k daÄŸ?l?m?
    const agirliklar = allEdges.map(e => e.weight || 0.5);
    const ortAgirlik = agirliklar.length > 0 ? agirliklar.reduce((s, w) => s + w, 0) / agirliklar.length : 0;
    const dusukAgirlik = agirliklar.filter(w => w < 0.3).length;

    // Ã–z-bilgi: graph kendisi hakk?nda ne biliyor?
    const selfNodes = ['axiom', 'kernel', 'dream', 'rüya', 'hipotez'];
    const selfBilgi = {};
    for (const n of selfNodes) {
      const node = this.graph.getNode(n, workspaceId);
      if (node) {
        const edges = this.graph.getEdges(n, workspaceId);
        selfBilgi[n] = { var: true, kenar: edges.length };
      } else {
        selfBilgi[n] = { var: false, kenar: 0 };
      }
    }

    // R?ya döngüs?
    const dreamCycle = this._dreamCount || 0;

    // Entropi (bilgi ?e?itliliÄŸi)
    const entropi = this.entropy(workspaceId);

    // Meta-g?ven skoru
    let metaGuven = 0.5;
    if (nodeCount > 0) {
      metaGuven += Math.min(0.2, nodeCount * 0.001);
      metaGuven -= Math.min(0.3, celiskiler.length * 0.05);
      metaGuven += Math.min(0.1, ortAgirlik * 0.1);
      metaGuven -= Math.min(0.1, yalitilmis.length * 0.02);
      metaGuven = Math.max(0, Math.min(1, metaGuven));
    }

    // Zay?f noktalar
    const zayifNoktalar = [];
    if (yalitilmis.length > 0) zayifNoktalar.push(`${yalitilmis.length} yal?t?lm?? d?ÄŸ?m`);
    if (celiskiler.length > 0) zayifNoktalar.push(`${celiskiler.length} çelişki`);
    if (dusukAgirlik > edgeCount * 0.3) zayifNoktalar.push(`${dusukAgirlik} d?k g?venli kenar`);
    if (nodeCount < 5) zayifNoktalar.push('?ok az bilgi');

    // G??l? noktalar
    const gucluNoktalar = [];
    if (nodeCount > 50) gucluNoktalar.push('geni? bilgi grafiÄŸi');
    if (typeEdges > 10) gucluNoktalar.push('g??l? tür hiyerar?isi');
    if (benzerEdges > 5) gucluNoktalar.push('aktif benzerlik aÄŸ?');
    if (dreamCycle > 0) gucluNoktalar.push(`${dreamCycle} r?ya döngüs? tamamland?`);

    const result = {
      bilgi: {
        dugum: nodeCount,
        kenar: edgeCount,
        tur: typeEdges,
        yapabilir: canEdges,
        ozellik: ozellikEdges,
        benzer: benzerEdges,
        hipotez: hipotezEdges,
        yalitilmis: yalitilmis.length,
        entropi: entropi.toFixed(3),
      },
      saglik: {
        metaGuven: parseFloat(metaGuven.toFixed(3)),
        celiski: celiskiler.length,
        bosluk: bosluklar.length,
        ortalamaAgirlik: parseFloat(ortAgirlik.toFixed(3)),
        dusukGuvenliKenar: dusukAgirlik,
      },
      ozBilgi: selfBilgi,
      zayifNoktalar,
      gucluNoktalar,
      dreamCycle,
    };

    this.plugins.emit('afterIntrospect', result);
    return this._ok('introspect', result);
  }

  getPersistenceDescriptor() {
    const memoryPath = this.graph?.memoryPath || 'memory.json';

    return Object.freeze({
      memoryPath,
      dbPath: String(memoryPath).replace(/\.json$/i, '.db'),
    });
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
    const edges = this.graph._edges;
    const removed = [];
    const marked = new Set();

    // 1. Ayn? (from, to) i?in d?k weight kenarlar? temizle (tür vs değil gibi)
    const byPair = {};
    for (let i = 0; i < edges.length; i++) {
      if (edges[i].kistlama) continue;
      const key = `${edges[i].from}|${edges[i].to}`;
      if (!byPair[key]) byPair[key] = [];
      byPair[key].push(i);
    }

    for (const [, indices] of Object.entries(byPair)) {
      const high = indices.filter(i => edges[i].weight >= 0.5);
      const low = indices.filter(i => edges[i].weight < 0.3);
      for (const li of low) {
        // D?k weight kenar?n y?ksek weight alternatifi varsa temizle
        if (high.length > 0) {
          removed.push({ idx: li, edge: edges[li],
            reason: `low-weight (${edges[li].weight}) superseded by high-weight (${edges[high[0]].weight}) for same pair` });
          marked.add(li);
        }
      }
    }

    // 2. Ayn? (from, relation) i?in d?k weight kenarlar? temizle (restriction artifacts)
    const byRel = {};
    for (let i = 0; i < edges.length; i++) {
      if (marked.has(i) || edges[i].kistlama) continue;
      const key = `${edges[i].from}|${edges[i].relation}`;
      if (!byRel[key]) byRel[key] = [];
      byRel[key].push(i);
    }

    for (const [, indices] of Object.entries(byRel)) {
      const high = indices.filter(i => edges[i].weight >= 0.5);
      const low = indices.filter(i => edges[i].weight < 0.3);
      for (const li of low) {
        if (high.length > 0 && !marked.has(li)) {
          removed.push({ idx: li, edge: edges[li],
            reason: `low-weight restriction (${edges[li].weight}) â€” subject already has high-weight '${edges[li].relation}'` });
          marked.add(li);
        }
      }
    }

    // 3. Uygula
    if (!dryRun && removed.length > 0) {
      this.graph._edges = edges.filter((_, i) => !marked.has(i));
      this.graph._rebuildIndex();
      try { this.graph.save(); } catch (e) { console.error("[Kernel] Graph save hatası:", e.message); }
    }

    return {
      dryRun,
      removed: removed.length,
      details: removed.map(r =>
        `${r.edge.from} ? ${r.edge.to} (${r.edge.relation}, w:${r.edge.weight}): ${r.reason}`
      ),
    };
  }

  /**
   * Kendi kendine evrimle?me döngüs?.
   * 1. R?ya g?r (hipotez ?ret)
   * 2. Y?ksek g?venli hipotezleri bilgiye d?n??tür
   * 3. GrafiÄŸi temizle (birle?tir + optimize et)
   * 4. Kaydet, rapor d?ndır
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
   * Kendi kendine ?ÄŸrenme â€” bo?luklar? tespit edip doldurur.
   * Bilinmeyen kavramlar? bulur ve LLM'den ?ÄŸrenir.
   */
  selfLearn(opts = {}) {
    const gaps = this.detectGaps();
    if (gaps.length === 0) return { gaps: 0, learned: 0, message: 'Bo?luk yok' };

    const before = this.graph._edges.length;
    for (const gapId of gaps) {
      const node = this.graph.getNode(gapId);
      if (!node) continue;
      const hasAnyEdge = this.graph.getEdges(gapId).length > 0 || this.graph.getInEdges(gapId).length > 0;
      if (hasAnyEdge) continue;

      const sim = this.graph.cosineSimilarity ? this.graph.cosineSimilarity(gapId, gapId) : 0;
    }

    const after = this.graph._edges.length;
    return { gaps: gaps.length, learned: after - before };
  }

  /**
   * Periyodik bak?m â€” ?ÄŸrenme sayac?n? takip eder, e?ik a??l?nca selfEvolve ?al??tür?r.
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

