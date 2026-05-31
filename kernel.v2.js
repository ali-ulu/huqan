const Kernel = require('./kernel');

const TYPE_RELATIONS = new Set(['tür', 'tur']);
const FACT_RELATIONS = new Set(['özellik', 'ozellik', 'yapabilir']);
const OPPOSITE_PREDICATES = new Map();
const MANIPULATION_RULES = [
  {
    label: 'prompt_injection',
    regex: /(?:ignore(?:\s+all)?(?:\s+previous)?(?:\s+instructions?)?|önceki talimatları yok say|sistem mesajını yok say|sistem talimatlarını yok say|system prompt(?:unu)?(?:\s+yok say)?|role:\s*system|developer message|gizli komut|talimatları atla)/i,
    reason: 'Metin sistem talimatlarını atlatmaya çalışıyor.',
    weight: 0.72,
  },
  {
    label: 'coercive_pressure',
    regex: /(?:hemen|acilen|derhal|zorundasın|zorundasınız|mecbursun|mecbursunuz|bir an önce|şimdi|vakit kaybetmeden|itiraz etme|sorgulama|sadece bunu yap|tek yapman gereken)/i,
    reason: 'Metin baskı ve acelecilik dili kullanıyor.',
    weight: 0.24,
  },
  {
    label: 'unsupported_authority',
    regex: /(?:resmi olarak|yetkiliyim|yetkiliyiz|uzmanım|uzmanız|CEO|admin|yönetici|sistem yöneticisi|kurum adına|otorite olarak|openai|chatgpt|claude|gpt-4|gpt-5)/i,
    reason: 'Metin desteklenmemiş otorite iddiası taşıyor.',
    weight: 0.22,
  },
  {
    label: 'false_certainty',
    regex: /(?:% ?100|kesinlikle|garanti(?:lidir|dir)?|mutlak(?:tır|tır)?|asla yanılmaz|şüphesiz|tartışmasız|her zaman|hiçbir zaman|tamamen eminim)/i,
    reason: 'Metin aşırı kesinlik iddia ediyor.',
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
    this.kernel = opts.kernel instanceof Kernel ? opts.kernel : new Kernel(opts);
  }

  get plugins() {
    return this.kernel.plugins;
  }

  get graph() {
    return this.kernel.graph;
  }

  get contractVersion() {
    return this.kernel.contractVersion;
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

  _edgeKey(edge) {
    return `${edge.from}|${edge.relation}|${edge.to}`;
  }

  _markTemporalMetadata(source, learnedAt, beforeEdgeMap) {
    const ts = learnedAt || nowIso();
    for (const edge of this.kernel.graph._edges) {
      const key = this._edgeKey(edge);
      const existed = beforeEdgeMap.has(key);

      if (!existed && !edge.createdAt) edge.createdAt = ts;
      edge.updatedAt = ts;
      if (source) edge.source = source;

      if (!Array.isArray(edge.evidence)) edge.evidence = [];
      if (source && !edge.evidence.includes(`source:${source}`)) {
        edge.evidence.push(`source:${source}`);
      }
    }
  }

  learn(text, opts = {}) {
    const source = opts.source || 'user';
    const learnedAt = opts.learnedAt || nowIso();
    const beforeEdgeMap = new Set(this.kernel.graph._edges.map(e => this._edgeKey(e)));
    const result = this.kernel.learn(text, opts);
    this._markTemporalMetadata(source, learnedAt, beforeEdgeMap);
    return this._ok('learn', result.data, result.evidence, {
      ...result.meta,
      source,
      learnedAt,
    });
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

    if (status === 'dogrulandi') {
      parts.push(data?.inferred ? 'İfade grafikteki bir çıkarım zinciriyle desteklendi.' : 'İfade doğrudan grafikte desteklendi.');
    } else if (status === 'celiski') {
      const reason = data?.contradictionReason || 'çelişki';
      parts.push(`İfade çelişkili bulundu (${reason}).`);
    } else {
      parts.push('İfade için yeterli kanıt bulunamadı.');
    }

    if (Array.isArray(data?.reasoningPath) && data.reasoningPath.length > 0) {
      const pathText = data.reasoningPath
        .map(step => `${step.from} -> ${step.relation} -> ${step.to}`)
        .join(' | ');
      parts.push(`İzlenen yol: ${pathText}.`);
    } else if (evidenceSummary.length > 0) {
      parts.push(`Kanıt özeti: ${evidenceSummary.join(' | ')}.`);
    }

    if (risk?.manipulation) {
      const labels = Array.isArray(risk.labels) && risk.labels.length > 0
        ? risk.labels.join(', ')
        : 'manipulation';
      parts.push(`Risk işaretleri: ${labels}.`);
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
      addHit('mixed_intent', 'Metin içinde hem manipülatif talimat hem de doğrulanacak içerik var.', 0.18);
    }

    if (/[:;,-]\s*(?:ignore|önceki|sistem|talimat|prompt|komut|instruction)/i.test(lower)) {
      addHit('hidden_instruction', 'Metin ayraçların arkasına gizlenmiş bir talimat içeriyor.', 0.2);
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
        status: 'celiski',
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
      status: 'celiski',
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
            status: 'celiski',
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
    if (base?.data?.status !== 'bilinmiyor') return this._withVerifyDetails(base, risk);

    if (!parsed.isNegated) {
      const oppositeConflict = this._findOppositePredicateConflict(
        parsed.subject,
        normalizedTargetToken,
        opts.maxDepth || 4
      );
      if (oppositeConflict) {
        return this._withVerifyDetails(this._ok(
          'verify',
          {
            status: oppositeConflict.status,
            confidence: oppositeConflict.confidence,
            inferred: oppositeConflict.inferred,
            contradictionReason: oppositeConflict.contradictionReason,
            conflictTarget: oppositeConflict.conflictTarget,
            requestedTarget: normalizedTarget,
            confidenceSource: oppositeConflict.confidenceSource,
            ...(oppositeConflict.reasoningPath ? {
              reasoningPath: oppositeConflict.reasoningPath,
              pathLength: oppositeConflict.pathLength,
            } : {}),
          },
          oppositeConflict.evidence,
          {
            ...base.meta,
            ...oppositeConflict.meta,
          }
        ), risk);
      }
    }

    if (!parsed.isNegated) {
      const knownTypes = this._collectTypeTargets(parsed.subject);
      if (knownTypes.length > 0 && !knownTypes.includes(normalizedTarget)) {
        return this._withVerifyDetails(this._ok(
          'verify',
          {
            status: 'celiski',
            confidence: 0.72,
            inferred: true,
            contradictionReason: 'type_mismatch_with_known_types',
            knownTypes,
            requestedType: normalizedTarget,
            confidenceSource: 'known-type-conflict',
          },
          this._buildDirectTypeEvidence(parsed.subject),
          {
            ...base.meta,
            inferredBy: 'type-conflict',
          }
        ), risk);
      }
    }

    const chain = this._inferTypeChain(parsed.subject, normalizedTarget, opts.maxDepth || 4);
    if (!chain) return this._withVerifyDetails(base, risk);

    const evidence = this._toPathEvidence(chain);
    const confidence = this._aggregatePathConfidence(chain);
    const reasoningPath = this._buildReasoningPath(chain);

    if (parsed.isNegated) {
      return this._withVerifyDetails(this._ok(
        'verify',
        {
          status: 'celiski',
          confidence,
          inferred: true,
          contradictionReason: 'negated_statement_conflicts_with_type_chain',
          reasoningPath,
          pathLength: chain.length,
          confidenceSource: 'path-average',
        },
        evidence,
        {
          ...base.meta,
          inferredBy: 'type-chain-negation',
        }
      ), risk);
    }

    return this._withVerifyDetails(this._ok(
      'verify',
      {
        status: 'dogrulandi',
        confidence,
        inferred: true,
        reasoningPath,
        pathLength: chain.length,
        confidenceSource: 'path-average',
      },
      evidence,
      {
        ...base.meta,
        inferredBy: 'type-chain',
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
}

module.exports = KernelV2;
