const {
  normalizeWorkspaceId,
  edgeClaim,
  normalizeForVerify,
  foldTurkishAscii,
  stripCopulaSuffix,
  phraseMatches,
  sharedPrefixLength,
  hasSharedSemanticAnchor,
  isPreventRelation,
  uniqueFlags,
  maxSignalScore,
  buildVerifySemanticTrust,
} = require("./verify-native");

const { DEFAULT_SEMANTIC_THRESHOLDS, normalizeSemanticClassification } = require("./semantic-score");
const {
  detectAbsoluteClaim,
  detectAliasNormalization,
  detectDoubleNegation,
  detectHighRiskDomain,
  detectMultilingualAmbiguity,
  detectStrawmanAttribution,
  detectWeakPartialMatch,
  detectWeaselWords,
} = require("./risk-rules");
const { runContradictionRules } = require("./contradiction-rules");
const { analyzeFuzzyOverlap, normalizeFuzzyText } = require("./fuzzy-normalization");
const { runSemanticSignals } = require("./semantic-signals");
const { detectTypeLatticeConflict } = require("./type-lattice");
const { normalizeText } = require("./text-utils");
const { decomposeClaim } = require("./claim-decomposition");
const { aggregateSubclaimVerdicts, buildReasoningTrace } = require("./reasoning-trace");
const { resolveEntity } = require("./entity-resolution");

class VerifyService {
  constructor(kernel) {
    this.kernel = kernel;
  }

  verify(statement, opts = {}) {
    const workspaceId = typeof opts.workspaceId === 'string' && opts.workspaceId.trim()
      ? opts.workspaceId.trim()
      : 'default';
    if (typeof statement !== 'string' || !statement.trim()) {
      return this._verifyResult(String(statement ?? ''), opts, { status: 'unknown', confidence: 0 }, [], { workspaceId });
    }
    const numericComparison = this.kernel._parseNumericComparison(statement);
    if (numericComparison) {
      return this._verifyResult(statement, opts, {
        status: numericComparison.ok ? 'verified' : 'contradicted',
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
        return this._verifyResult(statement, opts, { status: 'unknown', confidence: 0 }, [], {
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
          status: ['verified', 'contradicted', 'unknown'].includes(data.status) ? data.status : 'unknown',
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
      return this._verifyResult(statement, opts, { status: 'unknown', confidence: 0 }, [], { workspaceId, decomposition });
    }

    const subjectMatch = this._extractSubjectAndPredicate(statement, workspaceId, parts);
    let subject = subjectMatch.subject;
    let lookupSubject = subjectMatch.subject;
    let subjectNode = this.kernel.graph.getNode(lookupSubject, workspaceId);

    if (!subjectNode) {
      const subjectResolution = this._resolveCanonicalSubjectLookup(statement, subjectMatch, parts, workspaceId, opts.domain);
      subject = subjectResolution.subjectLiteral || subject;
      lookupSubject = subjectResolution.lookupSubject || lookupSubject;
      subjectNode = this.kernel.graph.getNode(lookupSubject, workspaceId);
    }

    const predicate = subjectMatch.predicate || parts.slice(1).join(' ');
    const edges = subjectNode ? this.kernel.graph.getEdges(lookupSubject, workspaceId) : [];
    const verifyContext = {
      workspaceId,
      subject,
      lookupSubject,
      predicate,
      edges,
      decomposition,
    };
    if (!subjectNode) {
      return this._verifyResult(statement, opts, { status: 'unknown', confidence: 0 }, [], verifyContext);
    }

    const predicateNumericComparison = this.kernel._parseNumericComparison(predicate);
    if (predicateNumericComparison) {
      return this._verifyResult(statement, opts, {
        status: predicateNumericComparison.ok ? 'verified' : 'contradicted',
        confidence: 0.95,
      }, [{
        kind: predicateNumericComparison.ok ? 'direct_edge' : 'contradiction',
        text: `Say�sal kar��la�t�rma: "${predicateNumericComparison.left} ${predicateNumericComparison.operator} ${predicateNumericComparison.right}"`,
        confidence: 0.95,
        nodes: [subject, String(predicateNumericComparison.left), String(predicateNumericComparison.right)],
        edges: [],
      }], verifyContext);
    }

    const negMatch = predicate.match(/^(.*?)\s+(de[gğĞ]il(?:dir)?|not)\s*$/i);
    if (negMatch) {
      const positive = negMatch[1].trim();
      if (positive) {
        const posNorm = this.kernel.normalizeWord(positive);
        const posEdge = edges.find(e => e.to === posNorm || e.to.includes(posNorm));
        if (posEdge) {
          return this._verifyResult(statement, opts, { status: 'contradicted', confidence: 0.85 }, [{
            kind: 'contradiction',
            text: `${subject} --[${posEdge.relation}]--> ${posEdge.to} var ama ifade olumsuz: "${predicate}"`,
            confidence: 0.85,
            nodes: [subject, posEdge.to],
            edges: [{ from: subject, to: posEdge.to, relation: posEdge.relation }],
          }], verifyContext);
        }
      }
    }

    const rawTarget = parts[parts.length - 1];
    const target = normalizeForVerify(this.kernel, rawTarget);
    const incomingAbsolute = Boolean(detectAbsoluteClaim(statement, {}));
    const normalizedPredicate = normalizeForVerify(this.kernel, predicate);
    const incoming = {
      text: statement,
      subject,
      relation: predicate,
      object: target,
      to: target,
    };
    const directEdge = edges.find(e => phraseMatches(normalizedPredicate, normalizeForVerify(this.kernel, e.to)));
    if (directEdge) {
      // PREVENTS edge contradicts affirmative claim
      // e.g. "sigara PREVENTS sağlık" means "Sigara sağlıklıdır" is a contradiction
      if (directEdge.relation === 'PREVENTS') {
        const pConfidence = Math.min(0.95, (directEdge.strength ?? directEdge.confidence ?? directEdge.weight ?? 0.5) + 0.3);
        return this._verifyResult(statement, opts, { status: 'contradicted', confidence: pConfidence }, [{
          kind: 'contradiction',
          text: `${subject} --[PREVENTS]--> ${directEdge.to} ile çelişiyor: "${statement}"`,
          confidence: pConfidence,
          nodes: [subject, directEdge.to],
          edges: [{ from: subject, to: directEdge.to, relation: 'PREVENTS' }],
        }], { ...verifyContext, directEdge });
      }
      if (incomingAbsolute) {
        // Absolute claims should not be promoted by a single supporting edge.
      } else {
        const confidence = Math.min(0.95, (directEdge.confidence ?? directEdge.weight ?? 0.5) + 0.4);
        const directObject = normalizeForVerify(this.kernel, directEdge.to);
        const preventConflictEdge = edges.find(edge =>
          edge !== directEdge &&
          isPreventRelation(edge.relation) &&
          hasSharedSemanticAnchor(directObject, normalizeForVerify(this.kernel, edge.to))
        );
        if (preventConflictEdge) {
          const contradictionSignal = {
            rule: 'CAUSE_PREVENT_OPPOSITION',
            kind: 'contradiction',
            severity: 0.9,
            confidence: 0.95,
            flags: ['CAUSE_PREVENT_OPPOSITION', 'SEMANTIC_OPPOSITION'],
            detail: 'Direct support conflicts with sibling prevent/opposition evidence.',
            evidence: [
              { text: `${subject} ${directEdge.relation} ${directEdge.to}`, role: 'support' },
              { text: `${subject} ${preventConflictEdge.relation} ${preventConflictEdge.to}`, role: 'opposition' },
            ],
            meta: {
              storedRelation: preventConflictEdge.relation,
              incomingRelation: directEdge.relation || predicate,
              oppositionFamily: 'cause_prevent',
            },
          };
          return this._verifyResult(statement, opts, { status: 'contradicted', confidence: 0.85 }, [{
            kind: 'contradiction',
            text: `${subject} --[${preventConflictEdge.relation}]--> ${preventConflictEdge.to} ile çelişiyor: "${statement}"`,
            confidence: 0.85,
            nodes: [subject, directEdge.to, preventConflictEdge.to].filter(Boolean),
            edges: [
              { from: subject, to: directEdge.to, relation: directEdge.relation },
              { from: subject, to: preventConflictEdge.to, relation: preventConflictEdge.relation },
            ],
          }], { ...verifyContext, directEdge, contradictionSignals: [contradictionSignal] });
        }
        return this._verifyResult(statement, opts, { status: 'verified', confidence }, [this.kernel._edgeEvidence(directEdge, 'direct_edge', confidence)], { ...verifyContext, directEdge });
      }
    }

    const typeConflict = target && target !== subject
      ? detectTypeLatticeConflict(this.kernel.graph, subject, target, workspaceId, {})
      : null;
    if (typeConflict) {
      return this._verifyResult(statement, opts, { status: 'contradicted', confidence: typeConflict.confidence || 0.9 }, typeConflict.evidence || [{
        kind: 'contradiction',
        text: typeConflict.detail,
        confidence: typeConflict.confidence,
        nodes: [subject, target],
        edges: [],
      }], { ...verifyContext, typeConflict });
    }

    const cons = this.kernel.detectContradictions(subject, workspaceId);
    const subjCons = cons.filter(c => c.node === subject);
    if (subjCons.length > 0) {
      const evidence = subjCons.map(c => this.kernel._contradictionEvidence(c));
      return this._verifyResult(statement, opts, { status: 'contradicted', confidence: 0.7 }, evidence, verifyContext);
    }

    if (target !== subject) {
      const pathResult = typeof this.kernel._findPathWithTimeout === 'function'
        ? this.kernel._findPathWithTimeout(subject, target, opts.pathTimeoutMs ?? 100, workspaceId, 4)
        : { path: this.kernel._findPath(subject, target, new Set(), [], 4, workspaceId), stoppedReason: null, timeoutMs: opts.pathTimeoutMs ?? 100, maxDepth: 4, workspaceId, visitedCount: 0 };
      if (pathResult.path && !incomingAbsolute) {
        return this._verifyResult(statement, opts, { status: 'verified', confidence: 0.5 }, [this.kernel._pathEvidence(pathResult.path, 'path', 0.5)], { ...verifyContext, pathSearch: pathResult });
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
              return this._verifyResult(statement, opts, { status: 'contradicted', confidence: 0.75 }, [{
                kind: 'contradiction',
                text: `Say�sal �eli�ki: "${predicate}" ifadesinde ${stmtNums.join(',')} ama "${edge.to}" bilgisinde ${edgeNums.join(',')}`,
                confidence: 0.75,
                nodes: [subject, edge.to],
                edges: [{ from: subject, to: edge.to, relation: edge.relation }],
              }], verifyContext);
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
          return this._verifyResult(statement, opts, { status: 'contradicted', confidence: 0.75 }, evidence, { ...verifyContext, fuzzy });
        }
        if (incomingAbsolute || fuzzy.isWeak) continue;
        return this._verifyResult(statement, opts, { status: 'verified', confidence: 0.35 }, [this.kernel._edgeEvidence(match, 'partial_match', 0.35)], { ...verifyContext, fuzzy });
      }
    }

    return this._verifyResult(statement, opts, { status: 'unknown', confidence: 0 }, [], verifyContext);
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
      contradictionSignals: Array.isArray(context.contradictionSignals) ? context.contradictionSignals : [],
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
    const subjectLiteral = typeof context.subjectLiteral === 'string' && context.subjectLiteral.trim()
      ? context.subjectLiteral.trim()
      : (typeof context.subject === 'string' ? context.subject.trim() : '');
    const lookupSubject = typeof context.lookupSubject === 'string' && context.lookupSubject.trim()
      ? context.lookupSubject.trim()
      : (typeof context.subject === 'string' ? context.subject.trim() : '');
    const resolvedSubject = subjectLiteral
      ? resolveEntity(subjectLiteral, { domain: opts.domain })
      : { matched: false, reason: 'empty_subject' };
    const entityResolution = {
      subject: subjectLiteral
        ? {
            original: subjectLiteral,
            ...resolvedSubject,
            usedForLookup: Boolean(
              lookupSubject &&
              lookupSubject !== subjectLiteral &&
              resolvedSubject.matched &&
              !resolvedSubject.ambiguous &&
              resolvedSubject.canonical === lookupSubject
            ),
          }
        : { original: '', matched: false, reason: 'empty_subject', usedForLookup: false },
    };
    return this.kernel._ok('verify', nextData, evidence, { semanticTrust, reasoningTrace, trustReceiptPreview, entityResolution });
  }

  _resolveCanonicalSubjectLookup(statement, subjectMatch, parts, workspaceId, domain) {
    const rawTokens = String(statement || '').trim().match(/\S+/g) || [];
    const domainValue = typeof domain === 'string' && domain.trim() ? domain.trim() : undefined;
    const candidateLimit = Math.max(1, Math.min(4, rawTokens.length - 1));
    const seen = new Set();

    let fallbackLiteral = subjectMatch?.subject || rawTokens[0] || '';
    let lookupSubject = subjectMatch?.subject || fallbackLiteral;

    for (let len = candidateLimit; len >= 1; len--) {
      const candidate = rawTokens.slice(0, len).join(' ').trim();
      if (!candidate) continue;

      const normalizedCandidate = this.kernel.normalizeWord(candidate);
      if (!normalizedCandidate || seen.has(normalizedCandidate)) continue;
      seen.add(normalizedCandidate);

      const resolution = resolveEntity(candidate, { domain: domainValue });
      fallbackLiteral = candidate;

      if (resolution.ambiguous) {
        return {
          subjectLiteral: candidate,
          lookupSubject,
        };
      }

      if (resolution.matched && resolution.canonical) {
        const canonicalNode = this.kernel.graph.getNode(resolution.canonical, workspaceId);
        if (canonicalNode) {
          return {
            subjectLiteral: candidate,
            lookupSubject: resolution.canonical,
          };
        }
        return {
          subjectLiteral: candidate,
          lookupSubject: candidate,
        };
      }
    }

    return {
      subjectLiteral: fallbackLiteral,
      lookupSubject,
    };
  }

  detectContradictions(subject = '', workspaceId = 'default') {
    const scope = typeof workspaceId === 'string' && workspaceId.trim() ? workspaceId.trim() : 'default';
    const allNodes = Object.values(this.kernel.graph.getNodes(scope)).filter(node => !subject || node.id === subject);
    const contradictions = [];

    // The five detection passes below each used to call getEdges() for the same
    // node, so every node was fetched five times -- O(5*N) graph reads on a path
    // that introspect() runs on every verify, and autoThinkTick runs every third
    // tick (#395). Fetch once up front and let each pass read from here.
    //
    // The passes stay separate rather than being fused into one node loop: the
    // returned array is ordered by contradiction type (every 'çoklu-tür', then
    // every 'döngü', ...), and fusing them would reorder it to node-major.
    // That ordering is observable to callers, so this change is purely about
    // how often the graph is read, not about what comes back.
    const edgesByNode = new Map();
    for (const node of allNodes) {
      edgesByNode.set(node.id, this.kernel.graph.getEdges(node.id, scope));
    }
    const edgesOf = nodeId => edgesByNode.get(nodeId) || [];

    for (const node of allNodes) {
      const edges = edgesOf(node.id);
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

    // Tracks which nodes already produced a 'döngü' entry. The original guard
    // rescanned the whole contradictions array per edge; at this point the array
    // only holds 'çoklu-tür' and 'döngü' entries, so a set of node ids is an
    // exact stand-in for that scan without its O(N*E*C) cost.
    const cycleNodes = new Set();
    for (const node of allNodes) {
      const nodeEdges = edgesOf(node.id);
      for (const edge of nodeEdges) {
        if (edge.relation !== 'tür') continue;
        const backEdge = this.kernel.graph.getEdge(edge.to, node.id, 'tür', scope);
        if (backEdge && !cycleNodes.has(node.id)) {
          cycleNodes.add(node.id);
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
      const edges = edgesOf(node.id);
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
      const edges = edgesOf(node.id);
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
      const edges = edgesOf(node.id);
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
    const normalizedStatementForLookup = normalizeForVerify(this.kernel, statement);
    const nodes = Object.values(this.kernel.graph.getNodes(workspaceId))
      .map(node => ({
        id: node.id,
        normalized: normalizeText(node.id),
        lookup: normalizeForVerify(this.kernel, node.id),
      }))
      .filter(node => node.normalized || node.lookup)
      .sort((a, b) => Math.max(b.normalized.length, b.lookup.length) - Math.max(a.normalized.length, a.lookup.length));

    for (const node of nodes) {
      if (normalizedStatement === node.normalized || normalizedStatement.startsWith(`${node.normalized} `)) {
        return {
          subject: node.id,
          predicate: normalizedStatement.slice(node.normalized.length).trim(),
          matchedSubject: true,
        };
      }
      if (node.lookup && (normalizedStatementForLookup === node.lookup || normalizedStatementForLookup.startsWith(`${node.lookup} `))) {
        return {
          subject: node.id,
          predicate: normalizedStatementForLookup.slice(node.lookup.length).trim(),
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

