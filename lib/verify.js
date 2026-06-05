const { DEFAULT_SEMANTIC_THRESHOLDS, normalizeSemanticClassification } = require('./semantic-score');
const { decomposeClaim } = require('./claim-decomposition');
const { aggregateSubclaimVerdicts, buildReasoningTrace } = require('./reasoning-trace');
const {
  detectAbsoluteClaim,
  detectAliasNormalization,
  detectDoubleNegation,
  detectHighRiskDomain,
  detectMultilingualAmbiguity,
  detectStrawmanAttribution,
  detectWeakPartialMatch,
  detectWeaselWords,
} = require('./risk-rules');
const { runContradictionRules } = require('./contradiction-rules');
const { analyzeFuzzyOverlap } = require('./fuzzy-normalization');
const { runSemanticSignals } = require('./semantic-signals');
const { detectTypeLatticeConflict } = require('./type-lattice');
const { normalizeText } = require('./text-utils');
const { resolveEntity } = require('./entity-resolution');

function normalizeWorkspaceId(value, fallback = 'default') {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return fallback;
}

function edgeClaim(edge = {}) {
  return {
    text: `${edge.from || ''} ${edge.relation || ''} ${edge.to || ''}`.trim(),
    subject: edge.from || '',
    relation: edge.relation || '',
    object: edge.to || '',
    to: edge.to || '',
  };
}

function uniqueFlags(signals = []) {
  return [...new Set([].concat(...signals.map(signal => Array.isArray(signal?.flags) ? signal.flags : [])))].filter(Boolean);
}

function maxSignalScore(signals = []) {
  return signals.reduce((max, signal) => Math.max(
    max,
    Number(signal?.severity) || 0,
    Number(signal?.confidence) || 0,
  ), 0);
}

function buildVerifySemanticTrust({
  statement = '',
  result = {},
  evidence = [],
  subject = '',
  predicate = '',
  edges = [],
  workspaceId = 'default',
  pathSearch = null,
  fuzzy = null,
  typeConflict = null,
}) {
  const evidenceList = Array.isArray(evidence) ? evidence : [];
  const evidenceKinds = [...new Set(evidenceList.map(item => String(item?.kind || '').trim()).filter(Boolean))];
  const rawConfidence = Number(result?.confidence) || 0;
  const hasPartialEvidence = evidenceKinds.includes('partial_match');
  const hasPathEvidence = evidenceKinds.includes('path');
  const hasDirectEvidence = evidenceKinds.includes('direct_edge');

  let supportScore = 0;
  if (result?.status === 'dogrulandi') {
    if (hasPartialEvidence) {
      supportScore = Math.min(rawConfidence || 0.35, 0.49);
    } else if (hasPathEvidence) {
      supportScore = Math.max(rawConfidence, 0.75);
    } else if (hasDirectEvidence) {
      supportScore = Math.max(rawConfidence, 0.8);
    } else {
      supportScore = Math.max(rawConfidence, 0.8);
    }
  } else if (result?.status === 'celiski') {
    supportScore = 0;
  } else {
    supportScore = hasPartialEvidence ? Math.min(rawConfidence || 0.35, 0.49) : rawConfidence;
  }

  const riskSignals = [];
  const contradictionSignals = [];

  if (typeConflict) contradictionSignals.push(typeConflict);

  const weakPartial = (evidenceList.length > 0 || result?.status === 'dogrulandi')
    ? detectWeakPartialMatch({ confidence: supportScore, evidence: evidenceList }, {})
    : null;
  if (weakPartial) riskSignals.push(weakPartial);

  const highRisk = detectHighRiskDomain(statement, {});
  if (highRisk) riskSignals.push(highRisk);

  const absolute = detectAbsoluteClaim(statement, {});
  if (absolute) riskSignals.push(absolute);

  const doubleNegation = detectDoubleNegation(statement, {});
  if (doubleNegation) riskSignals.push(doubleNegation);

  const weaselWords = detectWeaselWords(statement, {});
  if (weaselWords) riskSignals.push(weaselWords);

  const strawman = detectStrawmanAttribution(statement, {});
  if (strawman) riskSignals.push(strawman);

  const aliasNormalization = detectAliasNormalization(statement, {});
  if (aliasNormalization) riskSignals.push(aliasNormalization);

  const multilingual = detectMultilingualAmbiguity(statement, {});
  if (multilingual) riskSignals.push(multilingual);

  if (result?.status !== 'dogrulandi' && Array.isArray(edges) && edges.length > 0) {
    const incoming = {
      text: statement,
      subject,
      relation: predicate,
      object: predicate,
      to: predicate,
    };
    for (const edge of edges) {
      const signals = runContradictionRules(edgeClaim(edge), incoming, {});
      if (Array.isArray(signals)) contradictionSignals.push(...signals);
    }
  }

  if (result?.status === 'celiski' && contradictionSignals.length === 0) {
    contradictionSignals.push({
      rule: 'VERIFY_CONTRADICTION',
      kind: 'contradiction',
      severity: 0.9,
      confidence: Math.max(0.7, rawConfidence),
      flags: ['VERIFY_CONTRADICTION'],
      detail: 'Verify returned contradiction.',
      evidence: evidenceList,
      meta: { statement, subject, predicate },
    });
  }

  const contradictionScore = maxSignalScore(contradictionSignals);
  const riskScore = maxSignalScore(riskSignals);

  let status = ['dogrulandi', 'celiski', 'bilinmiyor'].includes(result?.status) ? result.status : 'bilinmiyor';
  if (hasPartialEvidence && status === 'dogrulandi' && supportScore < DEFAULT_SEMANTIC_THRESHOLDS.supportVerified) {
    status = 'bilinmiyor';
  } else if (status !== 'dogrulandi' && contradictionScore >= DEFAULT_SEMANTIC_THRESHOLDS.contradictionConflict) {
    status = 'celiski';
  }

  const matchType = hasPartialEvidence
    ? 'partial_match'
    : hasPathEvidence
      ? 'path'
      : hasDirectEvidence
        ? 'direct_edge'
        : contradictionSignals.length > 0
          ? 'contradiction'
          : 'unknown';

  const signals = [...contradictionSignals, ...riskSignals];
  const warnings = uniqueFlags(signals);
  const semanticTrust = normalizeSemanticClassification({
    status,
    supportScore,
    contradictionScore,
    riskScore,
    matchType,
    warnings,
    risk: {
      flags: warnings,
      domain: highRisk?.meta?.domain || null,
      manipulation: false,
      absoluteClaim: Boolean(absolute),
      relationDrift: warnings.includes('RELATION_DRIFT'),
      highRisk: Boolean(highRisk),
    },
    signals,
      meta: {
        statement,
        subject,
        predicate,
        workspaceId,
        evidenceKinds,
        pathSearch,
        fuzzy,
        thresholds: { ...DEFAULT_SEMANTIC_THRESHOLDS },
      },
    });

  return {
    ...semanticTrust,
    confidence: Math.max(rawConfidence, semanticTrust.supportScore || 0, semanticTrust.contradictionScore || 0),
    thresholds: { ...DEFAULT_SEMANTIC_THRESHOLDS },
  };
}

class VerifyService {
  constructor(kernel) {
    this.kernel = kernel;
  }

  verify(statement, opts = {}) {
    const workspaceId = typeof opts.workspaceId === 'string' && opts.workspaceId.trim()
      ? opts.workspaceId.trim()
      : 'default';
    if (typeof statement !== 'string' || !statement.trim()) {
      return this._verifyResult(String(statement ?? ''), opts, { status: 'bilinmiyor', confidence: 0 }, [], { workspaceId });
    }
    const numericComparison = this.kernel._parseNumericComparison(statement);
    if (numericComparison) {
      return this._verifyResult(statement, opts, {
        status: numericComparison.ok ? 'dogrulandi' : 'celiski',
        confidence: 0.98,
      }, [{
        kind: numericComparison.ok ? 'direct_edge' : 'contradiction',
        text: `Say�sal kar��la�t�rma: "${numericComparison.left} ${numericComparison.operator} ${numericComparison.right}"`,
        confidence: 0.98,
        nodes: [String(numericComparison.left), String(numericComparison.right)],
        edges: [],
      }], { workspaceId });
    }

    const decomposition = decomposeClaim(statement, opts);
    if (decomposition.compound && !opts.skipDecomposition) {
      const traceDepth = Number(opts.reasoningTraceDepth) || 0;
      const maxDepth = Number.isFinite(Number(opts.maxDecompositionDepth)) ? Number(opts.maxDecompositionDepth) : 2;
      if (traceDepth >= maxDepth) {
        return this._verifyResult(statement, opts, { status: 'bilinmiyor', confidence: 0 }, [], {
          workspaceId,
          decomposition,
          reasoningTrace: buildReasoningTrace({
            claim: statement,
            decomposition,
            subclaimOutcomes: [],
            aggregate: aggregateSubclaimVerdicts([], { confidenceFloor: opts.confidenceFloor }),
          }),
        });
      }

      const subclaimResults = decomposition.subclaims.map((subclaim) => this.kernel._verifyInternal(subclaim.claim, {
        ...opts,
        workspaceId,
        skipDecomposition: true,
        reasoningTraceDepth: traceDepth + 1,
        parentClaim: statement,
        subclaimId: subclaim.id,
      }));

      const subclaimOutcomes = decomposition.subclaims.map((subclaim, index) => {
        const result = subclaimResults[index] || {};
        const data = result.data && typeof result.data === 'object' ? result.data : {};
        const semanticTrust = result.meta && typeof result.meta === 'object' ? result.meta.semanticTrust : null;
        const evidence = Array.isArray(result.evidence) ? result.evidence : [];
        const warnings = Array.isArray(semanticTrust?.warnings) ? semanticTrust.warnings : [];
        return {
          id: subclaim.id,
          claim: subclaim.claim,
          required: subclaim.required !== false,
          status: ['dogrulandi', 'celiski', 'bilinmiyor'].includes(data.status) ? data.status : 'bilinmiyor',
          confidence: typeof data.confidence === 'number' ? data.confidence : 0,
          evidence,
          rejectedEvidence: Array.isArray(data?.meta?.rejectedEvidence) ? data.meta.rejectedEvidence : [],
          downgradeReasons: Array.isArray(data?.meta?.downgradeReasons) ? data.meta.downgradeReasons : [],
          semanticTrust: semanticTrust || {},
          risk: semanticTrust?.risk || { flags: warnings },
        };
      });

      const aggregate = aggregateSubclaimVerdicts(subclaimOutcomes, {
        confidenceFloor: opts.confidenceFloor,
      });
      const reasoningTrace = buildReasoningTrace({
        claim: statement,
        decomposition,
        subclaimOutcomes,
        aggregate,
        semanticFlags: aggregate.reasons,
      }, { confidenceFloor: opts.confidenceFloor });
      const evidence = subclaimOutcomes.flatMap(item => Array.isArray(item.evidence) ? item.evidence : []);
      return this._verifyResult(statement, opts, {
        status: aggregate.status,
        confidence: aggregate.confidence,
      }, evidence, {
        workspaceId,
        decomposition,
        subclaimOutcomes,
        aggregate,
        reasoningTrace,
        trustReceiptPreview: reasoningTrace.trustReceiptPreview,
      });
    }

    const parts = statement.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      return this._verifyResult(statement, opts, { status: 'bilinmiyor', confidence: 0 }, [], { workspaceId, decomposition });
    }

    const subjectMatch = this._extractSubjectAndPredicate(statement, workspaceId, parts);
    const subject = subjectMatch.subject;
    const subjectNode = this.kernel.graph.getNode(subject, workspaceId);
    if (!subjectNode) {
      return this._verifyResult(statement, opts, { status: 'bilinmiyor', confidence: 0 }, [], { workspaceId, subject, decomposition });
    }

    const edges = this.kernel.graph.getEdges(subject, workspaceId);
    const predicate = subjectMatch.predicate || parts.slice(1).join(' ');

    const predicateNumericComparison = this.kernel._parseNumericComparison(predicate);
    if (predicateNumericComparison) {
      return this._verifyResult(statement, opts, {
        status: predicateNumericComparison.ok ? 'dogrulandi' : 'celiski',
        confidence: 0.95,
      }, [{
        kind: predicateNumericComparison.ok ? 'direct_edge' : 'contradiction',
        text: `Say�sal kar��la�t�rma: "${predicateNumericComparison.left} ${predicateNumericComparison.operator} ${predicateNumericComparison.right}"`,
        confidence: 0.95,
        nodes: [subject, String(predicateNumericComparison.left), String(predicateNumericComparison.right)],
        edges: [],
      }], { workspaceId, subject, predicate, edges, decomposition });
    }

    const negMatch = predicate.match(/^(.*?)\s+(de[�g]il|de[�g]ildir|not)\s*$/i);
    if (negMatch) {
      const positive = negMatch[1].trim();
      if (positive) {
        const posNorm = this.kernel.normalizeWord(positive);
        const posEdge = edges.find(e => e.to === posNorm || e.to.includes(posNorm));
        if (posEdge) {
          return this._verifyResult(statement, opts, { status: 'celiski', confidence: 0.85 }, [{
            kind: 'contradiction',
            text: `${subject} --[${posEdge.relation}]--> ${posEdge.to} var ama ifade olumsuz: "${predicate}"`,
            confidence: 0.85,
            nodes: [subject, posEdge.to],
            edges: [{ from: subject, to: posEdge.to, relation: posEdge.relation }],
          }], { workspaceId, subject, predicate, edges, decomposition });
        }
      }
    }

    const incomingAbsolute = Boolean(detectAbsoluteClaim(statement, {}));
    const directEdge = edges.find(e => predicate.includes(e.to) || e.to === predicate);
    if (directEdge) {
      if (incomingAbsolute) {
        // Absolute claims should not be promoted by a single supporting edge.
      } else {
        const confidence = Math.min(0.95, (directEdge.confidence ?? directEdge.weight ?? 0.5) + 0.4);
        return this._verifyResult(statement, opts, { status: 'dogrulandi', confidence }, [this.kernel._edgeEvidence(directEdge, 'direct_edge', confidence)], { workspaceId, subject, predicate, edges, directEdge, decomposition });
      }
    }

    const rawTarget = parts[parts.length - 1];
    const cleanTarget = rawTarget.replace(/(d\u0131r|dir|dur|d\u00fcr|t\u0131r|tir|tur|t\u00fcr)$/i, '');
    const target = this.kernel.normalizeWord(cleanTarget || rawTarget);
    const typeConflict = target && target !== subject
      ? detectTypeLatticeConflict(this.kernel.graph, subject, target, workspaceId, {})
      : null;
    if (typeConflict) {
      return this._verifyResult(statement, opts, { status: 'celiski', confidence: typeConflict.confidence || 0.9 }, typeConflict.evidence || [{
        kind: 'contradiction',
        text: typeConflict.detail,
        confidence: typeConflict.confidence,
        nodes: [subject, target],
        edges: [],
      }], { workspaceId, subject, predicate, edges, typeConflict, decomposition });
    }

    const cons = this.kernel.detectContradictions(subject, workspaceId);
    const subjCons = cons.filter(c => c.node === subject);
    if (subjCons.length > 0) {
      const evidence = subjCons.map(c => this.kernel._contradictionEvidence(c));
      return this._verifyResult(statement, opts, { status: 'celiski', confidence: 0.7 }, evidence, { workspaceId, subject, predicate, edges, decomposition });
    }

    if (target !== subject) {
      const pathResult = typeof this.kernel._findPathWithTimeout === 'function'
        ? this.kernel._findPathWithTimeout(subject, target, opts.pathTimeoutMs ?? 100, workspaceId, 4)
        : { path: this.kernel._findPath(subject, target, new Set(), [], 4, workspaceId), stoppedReason: null, timeoutMs: opts.pathTimeoutMs ?? 100, maxDepth: 4, workspaceId, visitedCount: 0 };
      if (pathResult.path && !incomingAbsolute) {
        return this._verifyResult(statement, opts, { status: 'dogrulandi', confidence: 0.5 }, [this.kernel._pathEvidence(pathResult.path, 'path', 0.5)], { workspaceId, subject, predicate, edges, pathSearch: pathResult, decomposition });
      }
    }

    const stmtNums = predicate.match(/\d+/g);
    if (stmtNums && edges.length > 0) {
      for (const edge of edges) {
        const edgeNums = String(edge.to).match(/\d+/g);
        if (edgeNums) {
          const mismatch = stmtNums.some((n, i) => edgeNums[i] && n !== edgeNums[i]);
          if (mismatch) {
            const stmtWords = parts.slice(1).filter(p => !/^\d+$/.test(p) && p.length > 1);
            const hasTextOverlap = stmtWords.some(w => edge.to.includes(w));
            if (hasTextOverlap) {
              return this._verifyResult(statement, opts, { status: 'celiski', confidence: 0.75 }, [{
                kind: 'contradiction',
                text: `Say�sal �eli�ki: "${predicate}" ifadesinde ${stmtNums.join(',')} ama "${edge.to}" bilgisinde ${edgeNums.join(',')}`,
                confidence: 0.75,
                nodes: [subject, edge.to],
                edges: [{ from: subject, to: edge.to, relation: edge.relation }],
              }], { workspaceId, subject, predicate, edges, decomposition });
            }
          }
        }
      }
    }

    for (const word of parts.slice(1)) {
      const w = this.kernel.normalizeWord(word);
      const match = edges.find(e => e.to === w || e.to.includes(w));
      if (match) {
        const candidate = edgeClaim(match);
        const incoming = {
          text: statement,
          subject,
          relation: predicate,
          object: target,
        };
        const semanticSignals = runSemanticSignals(candidate, incoming, {});
        const fuzzy = analyzeFuzzyOverlap(candidate.text, statement, { minOverlap: 2 });
        const contradictionSignals = semanticSignals.signals.filter(signal => signal.kind === 'contradiction');
        if (contradictionSignals.length > 0) {
          const evidence = contradictionSignals.map(signal => ({
            kind: 'contradiction',
            text: signal.detail || statement,
            confidence: signal.confidence,
            nodes: [subject, match.to],
            edges: [{ from: subject, to: match.to, relation: match.relation }],
          }));
          return this._verifyResult(statement, opts, { status: 'celiski', confidence: 0.75 }, evidence, { workspaceId, subject, predicate, edges, fuzzy, decomposition });
        }
        if (incomingAbsolute || fuzzy.isWeak) continue;
        return this._verifyResult(statement, opts, { status: 'dogrulandi', confidence: 0.35 }, [this.kernel._edgeEvidence(match, 'partial_match', 0.35)], { workspaceId, subject, predicate, edges, fuzzy, decomposition });
      }
    }

    return this._verifyResult(statement, opts, { status: 'bilinmiyor', confidence: 0 }, [], { workspaceId, subject, predicate, edges, decomposition });
  }

  _verifyResult(statement, opts, data, evidence, context = {}) {
    const workspaceId = normalizeWorkspaceId(opts.workspaceId || context.workspaceId);
    const semanticTrust = buildVerifySemanticTrust({
      statement,
      result: data,
      evidence,
      subject: context.subject || '',
      predicate: context.predicate || '',
      edges: Array.isArray(context.edges) ? context.edges : [],
      workspaceId,
      pathSearch: context.pathSearch || null,
      fuzzy: context.fuzzy || null,
      typeConflict: context.typeConflict || null,
    });
    const nextData = {
      ...data,
      status: semanticTrust.status,
      confidence: semanticTrust.confidence,
    };
    const decomposition = context.decomposition || (opts.skipDecomposition
      ? {
          originalClaim: statement,
          compound: false,
          subclaims: [{ id: 'claim_1', claim: statement, required: true, source: 'deterministic' }],
          warnings: [],
        }
      : decomposeClaim(statement));
    const subclaimOutcomes = Array.isArray(context.subclaimOutcomes) && context.subclaimOutcomes.length > 0
      ? context.subclaimOutcomes
      : [{
        id: 'claim_1',
        claim: statement,
        required: true,
        status: nextData.status,
        confidence: nextData.confidence,
        evidence: Array.isArray(evidence) ? evidence : [],
        rejectedEvidence: Array.isArray(context.rejectedEvidence) ? context.rejectedEvidence : [],
        downgradeReasons: Array.isArray(context.downgradeReasons) ? context.downgradeReasons : [],
        semanticTrust,
        risk: semanticTrust.risk || {},
      }];
    const aggregate = context.aggregate || aggregateSubclaimVerdicts(subclaimOutcomes, {
      confidenceFloor: opts.confidenceFloor,
    });
    const reasoningTrace = context.reasoningTrace || buildReasoningTrace({
      claim: statement,
      decomposition,
      subclaimOutcomes,
      aggregate,
      semanticFlags: semanticTrust.warnings,
    }, {
      confidenceFloor: opts.confidenceFloor,
    });
    const trustReceiptPreview = context.trustReceiptPreview || reasoningTrace.trustReceiptPreview;
    const subjectLiteral = typeof context.subject === 'string' ? context.subject.trim() : '';
    const entityResolution = {
      subject: subjectLiteral
        ? { original: subjectLiteral, ...resolveEntity(subjectLiteral, { domain: opts.domain }) }
        : { original: '', matched: false, reason: 'empty_subject' },
    };
    return this.kernel._ok('verify', nextData, evidence, { semanticTrust, reasoningTrace, trustReceiptPreview, entityResolution });
  }  detectContradictions(subject = '', workspaceId = 'default') {
    const scope = typeof workspaceId === 'string' && workspaceId.trim() ? workspaceId.trim() : 'default';
    const allNodes = Object.values(this.kernel.graph.getNodes(scope)).filter(node => !subject || node.id === subject);
    const contradictions = [];

    for (const node of allNodes) {
      const edges = this.kernel.graph.getEdges(node.id, scope);
      const typeEdges = edges.filter(e => e.relation === 'tür');
      if (typeEdges.length > 1) {
        contradictions.push({
          type: 'çoklu-tür',
          node: node.id,
          targets: typeEdges.map(e => e.to),
          confidence: Math.min(0.6, typeEdges.length * 0.15),
          edges: typeEdges,
          message: 'multi type detected: ' + typeEdges.map(e => e.to).join(', '),
        });
      }
    }

    for (const node of allNodes) {
      const nodeEdges = this.kernel.graph.getEdges(node.id, scope);
      for (const edge of nodeEdges) {
        if (edge.relation !== 'tür') continue;
        const backEdge = this.kernel.graph.getEdge(edge.to, node.id, 'tür', scope);
        if (backEdge && !contradictions.some(c => c.type === 'döngü' && c.node === node.id)) {
          contradictions.push({
            type: 'döngü',
            node: node.id,
            targets: [edge.to],
            confidence: 0.7,
            edges: [edge, backEdge],
            message: 'cycle detected between ' + node.id + ' and ' + edge.to,
          });
        }
      }
    }

    for (const node of allNodes) {
      const edges = this.kernel.graph.getEdges(node.id, scope);
      const degilEdges = edges.filter(e => e.relation === 'değil');
      if (degilEdges.length === 0) continue;
      const otherEdges = edges.filter(e => e.relation !== 'değil' && e.relation !== 'benzer' && e.relation !== 'hipotez');
      for (const degil of degilEdges) {
        const degilCore = degil.to.replace(/(?:maz|mez|mamak|memek|değildir|değil)$/i, '').trim();
        for (const other of otherEdges) {
          const otherCore = other.to.replace(/(?:maz|mez|mamak|memek|değildir|değil|yapabilir|yapamaz|edebilir|edemez)$/i, '').trim();
          if (degilCore.length > 3 && otherCore.length > 3 && (otherCore.includes(degilCore.slice(0, 8)) || degilCore.includes(otherCore.slice(0, 8)))) {
            contradictions.push({
              type: 'negasyon',
              node: node.id,
              targets: [degil.to, other.to],
              confidence: 0.8,
              message: 'negation conflict for ' + node.id,
              edges: [degil, other],
            });
          }
        }
      }
    }

    for (const node of allNodes) {
      const edges = this.kernel.graph.getEdges(node.id, scope);
      const edgesWithNums = [];
      for (const e of edges) {
        if (e.relation === 'hipotez') continue;
        const nums = this._extractNumbers(e.to);
        if (nums) edgesWithNums.push({ edge: e, nums });
      }
      if (edgesWithNums.length < 2) continue;
      for (let i = 0; i < edgesWithNums.length; i++) {
        for (let j = i + 1; j < edgesWithNums.length; j++) {
          if (edgesWithNums[i].nums === edgesWithNums[j].nums) continue;
          const coreI = this._getTextCore(edgesWithNums[i].edge.to);
          const coreJ = this._getTextCore(edgesWithNums[j].edge.to);
          const normI = coreI.replace(/\s+/g, ' ');
          const normJ = coreJ.replace(/\s+/g, ' ');
          const shorter = normI.length <= normJ.length ? normI : normJ;
          const longer = normI.length <= normJ.length ? normJ : normI;
          if (shorter.length < 5) continue;
          if (!longer.includes(shorter)) continue;
          contradictions.push({
            type: 'sayısal',
            node: node.id,
            targets: [edgesWithNums[i].edge.to, edgesWithNums[j].edge.to],
            confidence: 0.75,
            message: 'numeric conflict for ' + node.id,
            edges: [edgesWithNums[i].edge, edgesWithNums[j].edge],
          });
        }
      }
    }

    for (const node of allNodes) {
      const edges = this.kernel.graph.getEdges(node.id, scope);
      for (const e of edges) {
        if (e.relation === 'benzer' || e.relation === 'hipotez') continue;
        if (e.celiski || (e.weight !== undefined && e.weight < 0.3)) {
          contradictions.push({
            type: 'düşük-ağırlık',
            node: node.id,
            targets: [e.to],
            confidence: 0.6,
            message: 'low weight edge for ' + node.id,
            edges: [e],
          });
        }
      }
    }

    return contradictions;
  }

  _parseNumericComparison(text) {
    const raw = String(text || '').trim();
    if (!raw) return null;

    const match = raw.match(/^\s*(-?\d+(?:[.,]\d+)?)\s*(==|=|!=|<>|<=|>=|<|>)\s*(-?\d+(?:[.,]\d+)?)\s*$/);
    if (!match) return null;

    const left = Number(String(match[1]).replace(',', '.'));
    const operator = match[2];
    const right = Number(String(match[3]).replace(',', '.'));
    if (!Number.isFinite(left) || !Number.isFinite(right)) return null;

    let ok = false;
    switch (operator) {
      case '=':
      case '==':
        ok = left === right;
        break;
      case '!=':
      case '<>':
      case '?':
        ok = left !== right;
        break;
      case '<':
        ok = left < right;
        break;
      case '>':
        ok = left > right;
        break;
      case '<=':
        ok = left <= right;
        break;
      case '>=':
        ok = left >= right;
        break;
      default:
        return null;
    }

    return {
      ok,
      left,
      operator,
      right,
      text: raw,
    };
  }

  _extractSubjectAndPredicate(statement, workspaceId, parts = null) {
    const normalizedStatement = normalizeText(statement);
    const nodes = Object.values(this.kernel.graph.getNodes(workspaceId))
      .map(node => ({ id: node.id, normalized: normalizeText(node.id) }))
      .filter(node => node.normalized)
      .sort((a, b) => b.normalized.length - a.normalized.length);

    for (const node of nodes) {
      if (normalizedStatement === node.normalized || normalizedStatement.startsWith(`${node.normalized} `)) {
        return {
          subject: node.id,
          predicate: normalizedStatement.slice(node.normalized.length).trim(),
          matchedSubject: true,
        };
      }
    }

    const tokens = Array.isArray(parts) && parts.length > 0
      ? parts
      : normalizedStatement.split(/\s+/).filter(Boolean);
    const subject = this.kernel.normalizeWord(tokens[0] || '');
    const predicate = tokens.slice(1).join(' ');
    return {
      subject,
      predicate,
      matchedSubject: false,
    };
  }
  _contradictionEvidence(contradiction) {
    const targets = Array.isArray(contradiction.targets) ? contradiction.targets : [];
    const edges = Array.isArray(contradiction.edges)
      ? contradiction.edges.map(edge => this.kernel._edgeRef(edge))
      : targets.map(to => ({ from: contradiction.node, to, relation: contradiction.relation || 'tür' }));
    return {
      kind: 'contradiction',
      text: contradiction.message || `${contradiction.node} conflicts with ${targets.join(', ')}`,
      confidence: Math.max(0, Math.min(1, contradiction.confidence || 0.7)),
      nodes: [contradiction.node, ...targets],
      edges,
    };
  }

  _extractNumbers(text) {
    const turkishNums = {
      'bir':1,'iki':2,'uc':3,'dort':4,'bes':5,'alti':6,'yedi':7,'sekiz':8,'dokuz':9,
      'on':10,'yirmi':20,'otuz':30,'kirk':40,'elli':50,'altmis':60,'yetmis':70,'seksen':80,'doksan':90,
      'yuz':100,'bin':1000,
    };
    const words = text.toLowerCase().split(/\s+/).filter(Boolean);
    const nums = [];
    for (const w of words) {
      if (/^\d+$/.test(w)) nums.push(parseInt(w, 10));
      else if (turkishNums[w] !== undefined) nums.push(turkishNums[w]);
    }
    const digitMatches = text.match(/\d+/g);
    if (digitMatches) for (const d of digitMatches) nums.push(Number(d));
    if (nums.length === 0) return null;
    return [...new Set(nums)].sort((a,b)=>a-b).join(',');
  }

  _getTextCore(text) {
    const turkishNums = {
      'bir':1,'iki':2,'uc':3,'dort':4,'bes':5,'alti':6,'yedi':7,'sekiz':8,'dokuz':9,
      'on':10,'yirmi':20,'otuz':30,'kirk':40,'elli':50,'altmis':60,'yetmis':70,'seksen':80,'doksan':90,
      'yuz':100,'bin':1000,
    };
    let s = text.toLowerCase();
    for (const [word, num] of Object.entries(turkishNums)) {
      s = s.replace(new RegExp(`\\b${word}\\b`, 'g'), String(num));
    }
    return s.replace(/\d+/g, '').replace(/\s+/g, ' ').trim();
  }
}

module.exports = VerifyService;

