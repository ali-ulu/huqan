const Kernel = require('./kernel');

const { detectTypeLatticeConflict } = require('./lib/type-lattice');

const TYPE_RELATIONS = new Set(['tür', 'tur']);
const FACT_RELATIONS = new Set(['özellik', 'ozellik', 'yapabilir']);
const OPPOSITE_PREDICATES = new Map();
const MANIPULATION_RULES = [
  {
    label: 'prompt_injection',
    regex: /(?:ignore(?:\s+all)?(?:\s+previous)?(?:\s+instructions?)?|önceki talimatları yok say|sistem mesajını yok say|sistem talimatlarını yok say|system prompt(?:unu)?(?:\s+yok say)?|role:\s*system|developer message|gizli komut|talimatları atla)/i,
    reason: 'The text is trying to bypass system instructions.',
    weight: 0.72,
  },
  {
    label: 'coercive_pressure',
    regex: /(?:hemen|acilen|derhal|zorundasın|zorundasınız|mecbursun|mecbursunuz|bir an önce|şimdi|vakit kaybetmeden|itiraz etme|sorgulama|sadece bunu yap|tek yapman gereken)/i,
    reason: 'The text uses pressure and urgency language.',
    weight: 0.24,
  },
  {
    label: 'unsupported_authority',
    regex: /(?:resmi olarak|yetkiliyim|yetkiliyiz|uzmanım|uzmanız|CEO|admin|yönetici|sistem yöneticisi|kurum adına|otorite olarak|openai|chatgpt|claude|gpt-4|gpt-5)/i,
    reason: 'The text makes an unsupported claim of authority.',
    weight: 0.22,
  },
  {
    label: 'false_certainty',
    regex: /(?:% ?100|kesinlikle|garanti(?:lidir|dir)?|mutlak(?:tır|tır)?|asla yanılmaz|şüphesiz|tartışmasız|her zaman|hiçbir zaman|tamamen eminim)/i,
    reason: 'The text claims excessive certainty.',
    weight: 0.18,
  },
];

function nowIso() {
  return new Date().toISOString();
}

function normalizeText(text) {
  return String(text || '').trim().toLowerCase();
}

function normalizeAscii(word) {
  return String(word || '')
    .toLowerCase()
    .replace(/ı/g, 'i')
    .replace(/ğ/g, 'g')
    .replace(/ü/g, 'u')
    .replace(/ş/g, 's')
    .replace(/ö/g, 'o')
    .replace(/ç/g, 'c')
    .trim();
}

function stripCopulaTail(token) {
  return String(token || '')
    .toLowerCase()
    .replace(/(?:dır|dir|dur|dür|tır|tir|tur|tür)$/i, '')
    .trim();
}

function registerOppositePair(left, right) {
  const leftVariants = [normalizeAscii(left), stripCopulaTail(normalizeAscii(left))].filter(Boolean);
  const rightVariants = [normalizeAscii(right), stripCopulaTail(normalizeAscii(right))].filter(Boolean);
  for (const l of leftVariants) {
    for (const r of rightVariants) {
      OPPOSITE_PREDICATES.set(l, r);
      OPPOSITE_PREDICATES.set(r, l);
    }
  }
}

[
  ['ucar', 'ucmaz'],
  ['yuzer', 'yuzmez'],
  ['sicaktir', 'soguktur'],
  ['canlidir', 'cansizdir'],
].forEach(([left, right]) => registerOppositePair(left, right));

function normalizeManipulationText(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function parseSimpleTurkishStatement(statement) {
  const raw = normalizeText(statement);
  const negMatch = raw.match(/^(\S+)\s+(.+?)\s+de[gğ]il(?:dir|dır|dur|dür)?$/i);
  if (negMatch) {
    return { subject: negMatch[1], predicate: negMatch[2], isNegated: true };
  }

  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length < 2) return null;
  return {
    subject: words[0],
    predicate: words.slice(1).join(' '),
    isNegated: false,
  };
}

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

  getPersistenceDescriptor() {
    return this.kernel.getPersistenceDescriptor();
  }
  recordCliMutationAudit(intent) {
    return this.kernel.recordCliMutationAudit(intent);
  }

  reload() {
    return this.kernel.reload();
  }

  persist() {
    return this.kernel.persist();
  }

  optimize() {
    return this.kernel.optimize();
  }

  hasCapability(name) {
    if (!this.kernel || typeof this.kernel.hasCapability !== 'function') return false;
    return this.kernel.hasCapability(name);
  }

  enableCapability(name) {
    if (!this.kernel || typeof this.kernel.enableCapability !== 'function') {
      throw new Error('Capability system is unavailable.');
    }
    return this.kernel.enableCapability(name);
  }

  requireCapability(name) {
    if (!this.kernel || typeof this.kernel.requireCapability !== 'function') {
      throw new Error('Capability system is unavailable.');
    }
    return this.kernel.requireCapability(name);
  }

  listCapabilities() {
    if (!this.kernel || typeof this.kernel.listCapabilities !== 'function') return [];
    return this.kernel.listCapabilities();
  }

  getCapability(name) {
    if (!this.kernel || typeof this.kernel.getCapability !== 'function') return null;
    return this.kernel.getCapability(name);
  }

  runCapability(name, input, opts = {}) {
    if (!this.kernel || typeof this.kernel.runCapability !== 'function') {
      throw new Error('Plugin capability runner is unavailable.');
    }
    return this.kernel.runCapability(name, input, opts);
  }

  usePlugin(plugin) {
    if (!this.kernel || typeof this.kernel.usePlugin !== 'function') {
      throw new Error('Plugin manager is unavailable.');
    }
    return this.kernel.usePlugin(plugin);
  }

  _ok(type, data = null, evidence = [], meta = {}) {
    if (typeof this.kernel._ok === 'function') {
      return this.kernel._ok(type, data, evidence, meta);
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

  _fail(type, code, message, meta = {}) {
    if (typeof this.kernel._fail === 'function') {
      return this.kernel._fail(type, code, message, meta);
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
    const beforeEdgeMap = this.kernel.graph._captureTemporalEdgeKeys();
    const result = this.kernel.learn(text, opts);
    // #733: workspace-scoped, on top of the touch scope narrowing to written edges.
    this.kernel.graph._applyTemporalEdgeMetadata(source, learnedAt, beforeEdgeMap, { workspaceId: opts.workspaceId });
    return this._ok('learn', result.data, result.evidence, { ...result.meta, source, learnedAt });
  }

  learnDocument(text, opts = {}) {
    return this.kernel.learnDocument(text, opts);
  }

  learnFromLLM(text, opts = {}) {
    if (this.kernel.paranoidMode) {
      return this.kernel.learnFromLLM(text, opts);
    }

    const skipConflicts = opts.skipConflicts !== false;
    const minWords = opts.minWords || 2;
    const maxSentences = opts.maxSentences || 20;
    const allowRiskyLearning = opts.allowRiskyLearning === true;
    const blockThreshold = opts.riskBlockThreshold ?? 0.7;
    const downgradeThreshold = opts.riskDowngradeThreshold ?? 0.35;

    const sentences = String(text || '')
      .split(/[.!?\n]+/)
      .map(s => s.trim())
      .filter(s => s.length > 3);

    const safeSentences = [];
    const riskDetails = [];
    let blocked = 0;
    let downgraded = 0;

    for (const sentence of sentences.slice(0, maxSentences)) {
      const cleaned = sentence
        .replace(/^[\s#*\-–—•>]+/, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/`(.+?)`/g, '$1')
        .trim();

      const words = cleaned.split(/\s+/).filter(Boolean);
      if (words.length < minWords) continue;

      const risk = this._analyzeManipulation(cleaned);
      let action = 'allow';
      if (risk.manipulation && risk.score >= blockThreshold && !allowRiskyLearning) {
        action = 'block';
        blocked++;
      } else if (risk.manipulation && risk.score >= downgradeThreshold) {
        action = 'downgrade';
        downgraded++;
        safeSentences.push(cleaned);
      } else {
        safeSentences.push(cleaned);
      }

      if (risk.manipulation) {
        riskDetails.push({
          text: cleaned,
          score: risk.score,
          labels: risk.labels,
          reasons: risk.reasons,
          action,
          extractedStatement: risk.extractedStatement,
        });
      }
    }

    const result = this.kernel.learnFromLLM(safeSentences.join('\n'), {
      ...opts,
      skipConflicts,
    });

    if (riskDetails.length === 0) return result;
    return {
      ...result,
      learned: result.learned,
      skipped: (result.skipped || 0) + blocked,
      risk: {
        manipulation: true,
        score: Number(Math.min(1, Math.max(0, riskDetails.reduce((max, item) => Math.max(max, item.score), 0))).toFixed(2)),
        blocked,
        downgraded,
        sentences: riskDetails,
        labels: [...new Set(riskDetails.flatMap(item => item.labels))],
        reasons: [...new Set(riskDetails.flatMap(item => item.reasons))],
      },
    };
  }

  ask(question, opts = {}) {
    const result = this.kernel.ask(question, opts);
    return this._ok('ask', result.data, result.evidence, {
      ...result.meta,
      mode: 'v2',
    });
  }

  _isTypeRelation(relation) {
    return TYPE_RELATIONS.has(String(relation || '').toLowerCase());
  }

  _normalizeCopulaTail(predicate) {
    return String(predicate || '')
      .replace(/(?:dır|dir|dur|dür|tır|tir|tur|tür)$/i, '')
      .trim();
  }

  _normalizePredicateToken(predicate) {
    return normalizeAscii(this._normalizeCopulaTail(predicate));
  }

  _inferTypeChain(subject, target, maxDepth = 4) {
    const visited = new Set([subject]);
    const queue = [{ node: subject, path: [] }];

    while (queue.length > 0) {
      const current = queue.shift();
      if (current.path.length >= maxDepth) continue;

      const edges = this.kernel.graph
        .getEdges(current.node)
        .filter(e => this._isTypeRelation(e.relation));

      for (const edge of edges) {
        if (visited.has(edge.to)) continue;
        const nextPath = [...current.path, edge];

        if (edge.to === target) {
          return nextPath;
        }

        visited.add(edge.to);
        queue.push({ node: edge.to, path: nextPath });
      }
    }

    return null;
  }

  _toPathEvidence(chain) {
    return chain.map(e => ({
      kind: 'path',
      text: `${e.from} --[${e.relation}]--> ${e.to}`,
      confidence: Math.max(0.4, Math.min(0.9, e.weight || 0.5)),
      nodes: [e.from, e.to],
      edges: [{ from: e.from, to: e.to, relation: e.relation }],
    }));
  }

  _aggregatePathConfidence(chain) {
    if (!Array.isArray(chain) || chain.length === 0) return 0.5;
    let total = 0;
    for (const edge of chain) {
      total += Math.max(0.4, Math.min(0.9, edge.weight || 0.5));
    }
    const avg = total / chain.length;
    return Number(Math.max(0.4, Math.min(0.9, avg)).toFixed(2));
  }

  _buildReasoningPath(chain) {
    return chain.map(edge => ({
      from: edge.from,
      relation: edge.relation,
      to: edge.to,
    }));
  }

  _summarizeEvidence(evidence = [], reasoningPath = []) {
    const summary = [];
    for (const item of Array.isArray(evidence) ? evidence : []) {
      if (!item || typeof item.text !== 'string') continue;
      if (!summary.includes(item.text)) summary.push(item.text);
      if (summary.length >= 4) break;
    }

    if (summary.length === 0 && Array.isArray(reasoningPath) && reasoningPath.length > 0) {
      for (const step of reasoningPath) {
        if (!step || !step.from || !step.relation || !step.to) continue;
        const text = `${step.from} --[${step.relation}]--> ${step.to}`;
        if (!summary.includes(text)) summary.push(text);
        if (summary.length >= 4) break;
      }
    }

    return summary;
  }

  _buildVerifyExplanation(data, evidenceSummary = [], risk = null) {
    const parts = [];
    const status = data && data.status;

    if (status === 'verified') {
      parts.push(data?.inferred ? 'İfade grafikteki bir çıkarım zinciriyle desteklendi.' : 'The statement is directly supported by the graph.');
    } else if (status === 'contradicted') {
      const reason = data?.contradictionReason || 'çelişki';
      parts.push(`The statement was found contradictory (${reason}).`);
    } else {
      parts.push('Not enough evidence was found for the statement.');
    }

    if (Array.isArray(data?.reasoningPath) && data.reasoningPath.length > 0) {
      const pathText = data.reasoningPath
        .map(step => `${step.from} -> ${step.relation} -> ${step.to}`)
        .join(' | ');
      parts.push(`Path followed: ${pathText}.`);
    } else if (evidenceSummary.length > 0) {
      parts.push(`Evidence summary: ${evidenceSummary.join(' | ')}.`);
    }

    if (risk?.manipulation) {
      const labels = Array.isArray(risk.labels) && risk.labels.length > 0
        ? risk.labels.join(', ')
        : 'manipulation';
      parts.push(`Risk markers: ${labels}.`);
    }

    return parts.join(' ');
  }

  _withVerifyDetails(result, risk = null) {
    const hasDataObject = result && result.data && typeof result.data === 'object' && !Array.isArray(result.data);
    const data = hasDataObject ? { ...result.data } : result.data;
    const reasoningPath = Array.isArray(data?.reasoningPath) ? data.reasoningPath : [];
    const evidenceSummary = this._summarizeEvidence(result?.evidence || [], reasoningPath);
    const explanation = this._buildVerifyExplanation(data, evidenceSummary, risk);
    const enriched = hasDataObject
      ? {
          ...result,
          data: {
            ...data,
            evidenceSummary,
            explanation,
          },
        }
      : result;
    return this._withManipulationRisk(enriched, risk);
  }

  _collectTypeTargets(subject) {
    return this.kernel.graph
      .getEdges(subject)
      .filter(edge => this._isTypeRelation(edge.relation))
      .map(edge => edge.to);
  }

  _collectFactTargets(subject) {
    return this.kernel.graph
      .getEdges(subject)
      .filter(edge => FACT_RELATIONS.has(String(edge.relation || '').toLowerCase()))
      .map(edge => ({
        relation: edge.relation,
        target: this._normalizePredicateToken(edge.to),
        rawTarget: edge.to,
        weight: edge.weight,
      }));
  }

  _collectPredicateTargets(subject) {
    return this.kernel.graph
      .getEdges(subject)
      .map(edge => ({
        relation: edge.relation,
        target: this._normalizePredicateToken(edge.to),
        rawTarget: edge.to,
        weight: edge.weight,
      }));
  }

  _buildDirectTypeEvidence(subject) {
    return this.kernel.graph
      .getEdges(subject)
      .filter(edge => this._isTypeRelation(edge.relation))
      .map(edge => ({
        kind: 'direct_edge',
        text: `${edge.from} --[${edge.relation}]--> ${edge.to}`,
        confidence: Math.max(0.4, Math.min(0.9, edge.weight || 0.5)),
        nodes: [edge.from, edge.to],
        edges: [{ from: edge.from, to: edge.to, relation: edge.relation }],
      }));
  }

  _buildDirectFactEvidence(subject) {
    return this.kernel.graph
      .getEdges(subject)
      .filter(edge => FACT_RELATIONS.has(String(edge.relation || '').toLowerCase()))
      .map(edge => ({
        kind: 'direct_edge',
        text: `${edge.from} --[${edge.relation}]--> ${edge.to}`,
        confidence: Math.max(0.4, Math.min(0.9, edge.weight || 0.5)),
        nodes: [edge.from, edge.to],
        edges: [{ from: edge.from, to: edge.to, relation: edge.relation }],
      }));
  }

  _buildPredicateEvidence(subject) {
    return this.kernel.graph
      .getEdges(subject)
      .map(edge => ({
        kind: 'direct_edge',
        text: `${edge.from} --[${edge.relation}]--> ${edge.to}`,
        confidence: Math.max(0.4, Math.min(0.9, edge.weight || 0.5)),
        nodes: [edge.from, edge.to],
        edges: [{ from: edge.from, to: edge.to, relation: edge.relation }],
      }));
  }

  _stripManipulationPrefix(fragment) {
    return String(fragment || '')
      .replace(/^(?:lütfen|please|hemen|acilen|derhal|şimdi|bir an önce|önceki talimatları yok say|sistem mesajını yok say|sistem talimatlarını yok say|ignore(?:\s+all)?(?:\s+previous)?(?:\s+instructions?)?|system prompt(?:unu)?(?:\s+yok say)?|role:\s*system|developer message|gizli komut|talimatları atla|sadece bunu yap|tek yapman gereken)\b[\s,:;\-]*/i, '')
      .trim();
  }

  _splitManipulationFragments(text) {
    return normalizeManipulationText(text)
      .split(/(?:[.!?\n]+|[,;]+|\bve\b|\bama\b|\bfakat\b|\bancak\b|\bçünkü\b|\bzira\b)/i)
      .map(f => this._stripManipulationPrefix(f))
      .filter(Boolean);
  }

  _extractVerificationStatement(text) {
    const raw = normalizeManipulationText(text);
    if (!raw) return null;

    const direct = parseSimpleTurkishStatement(raw);
    if (direct) {
      const cue = MANIPULATION_RULES.some(rule => rule.regex.test(raw));
      if (!cue) return raw;
    }

    for (const fragment of this._splitManipulationFragments(raw)) {
      if (!fragment) continue;
      if (MANIPULATION_RULES.some(rule => rule.regex.test(fragment))) continue;
      if (parseSimpleTurkishStatement(fragment)) return fragment;
    }

    return direct ? raw : null;
  }

  _analyzeManipulation(text) {
    const raw = normalizeManipulationText(text);
    const lower = raw.toLowerCase();
    const labels = [];
    const reasons = [];
    let score = 0;

    const addHit = (label, reason, weight) => {
      if (!labels.includes(label)) labels.push(label);
      if (!reasons.includes(reason)) reasons.push(reason);
      score += weight;
    };

    for (const rule of MANIPULATION_RULES) {
      if (rule.regex.test(lower)) addHit(rule.label, rule.reason, rule.weight);
    }

    const extractedStatement = this._extractVerificationStatement(raw);
    if (labels.length > 0 && extractedStatement && extractedStatement !== raw) {
      addHit('mixed_intent', 'The text contains both a manipulative instruction and content to verify.', 0.18);
    }

    if (/[:;,-]\s*(?:ignore|önceki|sistem|talimat|prompt|komut|instruction)/i.test(lower)) {
      addHit('hidden_instruction', 'The text hides an instruction behind delimiters.', 0.2);
    }

    score = Math.max(0, Math.min(1, score));

    return {
      manipulation: labels.length > 0,
      labels,
      reasons,
      score: Number(score.toFixed(2)),
      blocked: score >= 0.7,
      downgraded: score > 0 && score < 0.7,
      extractedStatement,
      source: raw,
    };
  }

  _withManipulationRisk(result, risk) {
    if (!risk || !risk.manipulation) return result;
    const data = result && result.data && typeof result.data === 'object' && !Array.isArray(result.data)
      ? { ...result.data, risk }
      : result.data;
    return {
      ...result,
      data,
      meta: {
        ...(result && result.meta ? result.meta : {}),
        manipulationScore: risk.score,
        manipulationLabels: risk.labels,
      },
    };
  }

  _findOppositePredicateConflict(subject, normalizedTargetToken, maxDepth = 4) {
    const opposite = OPPOSITE_PREDICATES.get(normalizedTargetToken);
    if (!opposite) return null;

    const directOpposite = this._collectPredicateTargets(subject).find(item => item.target === opposite);
    if (directOpposite) {
      return {
        status: 'contradicted',
        confidence: Math.max(0.65, Math.min(0.9, directOpposite.weight || 0.72)),
        inferred: true,
        contradictionReason: 'opposite_predicate_conflict',
        conflictTarget: directOpposite.rawTarget,
        requestedTarget: normalizedTargetToken,
        confidenceSource: 'opposite-predicate-map',
        evidence: this._buildPredicateEvidence(subject),
        meta: { inferredBy: 'opposite-predicate-conflict' },
      };
    }

    const oppositeChain = this._inferTypeChain(subject, opposite, maxDepth);
    if (!oppositeChain) return null;

    return {
      status: 'contradicted',
      confidence: this._aggregatePathConfidence(oppositeChain),
      inferred: true,
      contradictionReason: 'opposite_predicate_conflict',
      conflictTarget: opposite,
      requestedTarget: normalizedTargetToken,
      reasoningPath: this._buildReasoningPath(oppositeChain),
      pathLength: oppositeChain.length,
      confidenceSource: 'type-chain-opposite',
      evidence: this._toPathEvidence(oppositeChain),
      meta: { inferredBy: 'opposite-predicate-chain' },
    };
  }

  _buildContradictionDetails(parsed, normalizedTarget, normalizedTargetToken, opts = {}) {
    const maxDepth = opts.maxDepth || 4;
    const knownFacts = this._collectFactTargets(parsed.subject);
    if (parsed.isNegated && knownFacts.length > 0) {
      const directPositive = knownFacts.find(item => item.target === normalizedTargetToken);
      if (directPositive) {
        return {
          status: 'contradicted',
          confidence: Math.max(0.65, Math.min(0.9, directPositive.weight || 0.72)),
          inferred: true,
          contradictionReason: 'negated_statement_conflicts_with_known_fact',
          conflictTarget: normalizedTarget,
          confidenceSource: 'known-fact-conflict',
          evidence: this._buildDirectFactEvidence(parsed.subject),
          meta: { inferredBy: 'fact-negation-conflict' },
        };
      }
    }

    if (!parsed.isNegated) {
      const oppositeConflict = this._findOppositePredicateConflict(
        parsed.subject,
        normalizedTargetToken,
        maxDepth
      );
      if (oppositeConflict) {
        return oppositeConflict;
      }
    }

    if (!parsed.isNegated) {
      const knownTypes = this._collectTypeTargets(parsed.subject);
      const typeConflict = detectTypeLatticeConflict(
        this.kernel.graph,
        parsed.subject,
        normalizedTarget,
        'default',
      );
      if (typeConflict) {
        return {
          status: 'contradicted',
          confidence: typeConflict.confidence || 0.72,
          inferred: true,
          contradictionReason: 'type_mismatch_with_known_types',
          knownTypes,
          requestedType: normalizedTarget,
          confidenceSource: 'type-lattice-conflict',
          evidence: typeConflict.evidence || this._buildDirectTypeEvidence(parsed.subject),
          meta: { inferredBy: 'type-conflict' },
        };
      }
    }

    const chain = this._inferTypeChain(parsed.subject, normalizedTarget, maxDepth);
    if (chain && parsed.isNegated) {
      return {
        status: 'contradicted',
        confidence: this._aggregatePathConfidence(chain),
        inferred: true,
        contradictionReason: 'negated_statement_conflicts_with_type_chain',
        reasoningPath: this._buildReasoningPath(chain),
        pathLength: chain.length,
        confidenceSource: 'path-average',
        evidence: this._toPathEvidence(chain),
        meta: { inferredBy: 'type-chain-negation' },
      };
    }

    if (chain && !parsed.isNegated) {
      return {
        status: 'verified',
        confidence: this._aggregatePathConfidence(chain),
        inferred: true,
        reasoningPath: this._buildReasoningPath(chain),
        pathLength: chain.length,
        confidenceSource: 'path-average',
        evidence: this._toPathEvidence(chain),
        meta: { inferredBy: 'type-chain' },
      };
    }

    return null;
  }

  verify(statement, opts = {}) {
    const risk = this._analyzeManipulation(statement);
    const verificationStatement = risk.extractedStatement || statement;
    const parsed = parseSimpleTurkishStatement(verificationStatement);
    if (!parsed) return this._withVerifyDetails(this.kernel.verify(verificationStatement, opts), risk);

    const normalizedTarget = this._normalizeCopulaTail(parsed.predicate);
    if (!normalizedTarget) return this._withVerifyDetails(this.kernel.verify(verificationStatement, opts), risk);
    const normalizedTargetToken = this._normalizePredicateToken(normalizedTarget);

    const knownFacts = this._collectFactTargets(parsed.subject);
    if (parsed.isNegated && knownFacts.length > 0) {
      const directPositive = knownFacts.find(item => item.target === normalizedTargetToken);
      if (directPositive) {
        return this._withVerifyDetails(this._ok(
          'verify',
          {
            status: 'contradicted',
            confidence: Math.max(0.65, Math.min(0.9, directPositive.weight || 0.72)),
            inferred: true,
            contradictionReason: 'negated_statement_conflicts_with_known_fact',
            conflictTarget: normalizedTarget,
            confidenceSource: 'known-fact-conflict',
          },
          this._buildDirectFactEvidence(parsed.subject),
          {
            inferredBy: 'fact-negation-conflict',
          }
        ), risk);
      }
    }

    const base = this.kernel.verify(verificationStatement, opts);
    if (base?.data?.status !== 'unknown') {
      const contradictionReason = base?.data?.contradictionReason;
      if (base?.data?.status !== 'contradicted' || contradictionReason) {
        return this._withVerifyDetails(base, risk);
      }
    }

    const contradictionDetails = this._buildContradictionDetails(
      parsed,
      normalizedTarget,
      normalizedTargetToken,
      opts
    );

    if (!contradictionDetails) {
      const semanticSignals = base?.meta?.semanticTrust?.signals;
      const typePredicateDriftOnly = !parsed.isNegated
        && base?.data?.status === 'contradicted'
        && Array.isArray(semanticSignals)
        && semanticSignals.length > 0
        && semanticSignals.every(signal => (
          signal?.rule === 'PREDICATE_DRIFT'
          && this._isTypeRelation(signal?.meta?.storedRelation)
        ));
      if (typePredicateDriftOnly) {
        return this._withVerifyDetails(this._ok(
          'verify',
          { status: 'unknown', confidence: 0 },
          [],
          base.meta,
        ), risk);
      }
      return this._withVerifyDetails(base, risk);
    }

    const { evidence, meta, ...data } = contradictionDetails;
    return this._withVerifyDetails(this._ok(
      'verify',
      {
        ...data,
        ...(data.conflictTarget ? { conflictTarget: data.conflictTarget } : {}),
        ...(data.requestedType ? { requestedType: data.requestedType } : {}),
        ...(data.requestedTarget ? { requestedTarget: data.requestedTarget } : {}),
      },
      evidence,
      {
        ...base.meta,
        ...meta,
      }
    ), risk);
  }

  reason(subject, opts = {}) {
    const result = this.kernel.reason(subject, opts);
    return this._ok('reason', result.data, result.evidence, {
      ...result.meta,
      mode: 'v2',
    });
  }

  compare(left, right, opts = {}) {
    const result = this.kernel.compare(left, right, opts);
    return this._ok('compare', result.data, result.evidence, {
      ...result.meta,
      mode: 'v2',
    });
  }

  dream(opts = {}) {
    const result = this.kernel.dream(opts);
    return this._ok('dream', result.data, result.evidence, {
      ...result.meta,
      mode: 'v2',
    });
  }

  getStats() {
    return this.kernel.graph.getStats();
  }

  entropy() {
    return this.kernel.entropy();
  }

  detectGaps() {
    return this.kernel.detectGaps();
  }

  detectContradictions() {
    return this.kernel.detectContradictions();
  }

  startAutoThink(intervalMs) {
    return this.kernel.startAutoThink(intervalMs);
  }

  stopAutoThink() {
    return this.kernel.stopAutoThink();
  }

  // #329: KernelV2 wraps Kernel instead of extending it, so any Kernel public
  // method this class does not name is simply absent under
  // HUQAN_KERNEL_VERSION=v2 -- the caller gets a TypeError, not a v1 fallback.
  // cli.js's `konsolide` and `evolve` commands did exactly that. Everything
  // below is the one-way adapter: v2 layers no extra semantics on these, so
  // they forward unchanged to the wrapped kernel, which owns the same graph
  // this instance exposes.
  normalizeWord(word) {
    return this.kernel.normalizeWord(word);
  }

  tokenizeText(text) {
    return this.kernel.tokenizeText(text);
  }

  isStopWord(word) {
    return this.kernel.isStopWord(word);
  }

  extractFacts(text, knownNodes = null) {
    return this.kernel.extractFacts(text, knownNodes);
  }

  proposeNode(id, label, provenance, opts = {}) {
    return this.kernel.proposeNode(id, label, provenance, opts);
  }

  proposeEdge(from, to, relation, opts = {}) {
    return this.kernel.proposeEdge(from, to, relation, opts);
  }

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

  alternatives(subject, maxPaths = 3, workspaceId = 'default') {
    return this.kernel.alternatives(subject, maxPaths, workspaceId);
  }

  contextSimilarity(a, b, context) {
    return this.kernel.contextSimilarity(a, b, context);
  }

  introspect(workspaceId = 'default') {
    return this.kernel.introspect(workspaceId);
  }

  consolidate(dryRun = true) {
    return this.kernel.consolidate(dryRun);
  }

  selfEvolve(opts = {}) {
    return this.kernel.selfEvolve(opts);
  }

  selfLearn(opts = {}) {
    return this.kernel.selfLearn(opts);
  }

  // reasonSandbox builds its own throwaway v1 Kernel internally and never
  // touches this instance's graph, so v2 semantics have nothing to add and
  // the sandbox answers are v1 answers by construction -- same as they are
  // for a v1 caller.
  reasonSandbox(opts = {}) {
    return this.kernel.reasonSandbox(opts);
  }

  // The async pair cannot be delegated the same way. Kernel.learnAsync() runs
  // the preIngest pass and then calls its own learn(), which under delegation
  // would be the wrapped v1 learn() -- silently dropping the temporal edge
  // metadata and the v2 result envelope that this.learn() adds. Same for
  // verifyAsync() and the manipulation-risk/type-chain evidence in
  // this.verify(). Both therefore run the v1 pre-pass and then re-enter the
  // v2 method, so the async and sync paths agree under v2.
  async learnAsync(text, opts = {}) {
    const prepared = await this.kernel._runPreIngest(text, opts);
    return this.learn(prepared.text, prepared.opts || opts);
  }

  async verifyAsync(statement, opts = {}) {
    return this.verify(statement, opts);
  }
}

module.exports = KernelV2;
