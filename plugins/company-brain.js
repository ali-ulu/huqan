const LLMAdapter = require('../llmAdapter');
const { adjustedConfidence } = require('../evidence-ranker');

function nowIso() {
  return new Date().toISOString();
}

function slug(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9çğıöşü]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'decision';
}

function ensureCompanyState(kernel) {
  if (!kernel._companyIngestState) {
    kernel._companyIngestState = {
      bySource: { repo: 0, markdown: 0, manual: 0 },
      lastIngestAt: null,
      ingestErrors: [],
    };
  }
  return kernel._companyIngestState;
}

function trackSuccess(kernel, sourceType, amount = 1) {
  const state = ensureCompanyState(kernel);
  if (!(sourceType in state.bySource)) state.bySource[sourceType] = 0;
  state.bySource[sourceType] += Math.max(0, Number(amount || 0));
  state.lastIngestAt = nowIso();
}

function trackError(kernel, sourceType, message) {
  const state = ensureCompanyState(kernel);
  state.ingestErrors.push({
    sourceType,
    message: String(message || 'unknown error'),
    at: nowIso(),
  });
  state.lastIngestAt = nowIso();
}

function addCompanyEdge(kernel, fromId, toId, relation, opts = {}) {
  kernel.graph.addNode(fromId, fromId);
  kernel.graph.addNode(toId, toId);
  return kernel.graph.addEdge(fromId, toId, relation, {
    source: opts.source || 'manual',
    sourceRef: opts.sourceRef || '',
    sessionId: opts.sessionId || '',
    sourceType: opts.sourceType || 'manual',
    companyMode: true,
    evidenceType: opts.evidenceType || 'user_experience',
    evidence: Array.isArray(opts.evidence) ? opts.evidence : [],
    confidence: typeof opts.confidence === 'number' ? opts.confidence : 0.65,
  });
}

function extractTokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9çğıöşü_:/.-]+/i)
    .map(item => item.trim())
    .filter(item => item.length >= 3);
}

function rankGraphMatches(kernel, tokens) {
  const nodes = Object.values(kernel.graph?._nodes || {});
  const scored = [];
  for (const node of nodes) {
    const hay = `${node.id} ${node.label}`.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (hay.includes(token)) score += 1;
    }
    if (score > 0) scored.push({ node, score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, 8);
}

function collectEvidenceFromMatches(kernel, matches) {
  const evidence = [];
  const sourceRefs = new Set();
  for (const match of matches) {
    const edges = kernel.graph.getEdges(match.node.id) || [];
    for (const edge of edges.slice(0, 4)) {
      evidence.push({
        from: edge.from,
        relation: edge.relation,
        to: edge.to,
        source_ref: edge.source_ref || '',
        source_type: edge.source_type || '',
        confidence: edge.confidence ?? edge.weight ?? 0.5,
      });
      if (edge.source_ref) sourceRefs.add(edge.source_ref);
    }
  }
  return {
    evidence,
    sourceRefs: [...sourceRefs],
  };
}

function describeEvidence(evidence) {
  if (!Array.isArray(evidence) || evidence.length === 0) return 'Graphte ilgili kanit bulunamadi.';
  return evidence
    .slice(0, 5)
    .map(item => `${item.from} -> [${item.relation}] -> ${item.to}`)
    .join(' ; ');
}

async function queryCompanyBrain(kernel, plugin, input = {}) {
  const question = String(input.question || input.text || '').trim();
  if (!question) {
    return { ok: false, error: 'question is required' };
  }

  const tokens = extractTokens(question);
  const matches = rankGraphMatches(kernel, tokens);
  const collected = collectEvidenceFromMatches(kernel, matches);

  if (collected.evidence.length > 0) {
    return {
      ok: true,
      mode: 'graph',
      source: 'graph',
      question,
      answer: describeEvidence(collected.evidence),
      evidence: collected.evidence,
      sourceRefs: collected.sourceRefs,
    };
  }

  if (kernel.hasCapability && kernel.hasCapability('llm')) {
    if (!plugin.adapter) plugin.adapter = new LLMAdapter();
    try {
      const llmRes = await plugin.adapter.ask(
        `Soru: ${question}\nGraph kaniti zayif. Kesinlik belirtmeden ihtiyatli cevap ver.`,
        'Kisa cevap ver, varsayimlari acikca belirt.'
      );
      if (llmRes && llmRes.ok && llmRes.data && llmRes.data.text) {
        return {
          ok: true,
          mode: 'llm-fallback',
          source: 'llm+graph',
          question,
          answer: llmRes.data.text.trim(),
          sourceRefs: [],
          evidence: [],
        };
      }
    } catch (_) {
      // graceful fallback
    }
  }

  return {
    ok: true,
    mode: 'manual-review',
    source: 'graph',
    question,
    answer: 'Graphte yeterli baglam yok. Ilgili source_ref kayitlariyla manuel inceleme onerilir.',
    sourceRefs: [],
    evidence: [],
  };
}

function ingestManual(kernel, input = {}) {
  const text = String(input.text || '').trim();
  if (!text) return { ok: false, error: 'manual ingest text is required' };

  const author = String(input.author || 'unknown').trim() || 'unknown';
  const date = String(input.date || nowIso().slice(0, 10)).trim() || nowIso().slice(0, 10);
  const sourceRef = `manual:${author}:${date}`;
  const noteNode = `manual-note:${author}:${date}:${slug(text.slice(0, 24))}`;

  kernel.graph.addNode(noteNode, noteNode);
  const facts = typeof kernel.extractFacts === 'function'
    ? (kernel.extractFacts(text, kernel.graph?._nodes) || [])
    : [];

  let added = 0;
  const rankingEnabled = kernel.hasCapability && kernel.hasCapability('evidenceRanking');
  for (const fact of facts) {
    const parsed = typeof kernel._parsePredicate === 'function' ? kernel._parsePredicate(fact.predicate) : null;
    if (!parsed || !fact.subject || !parsed.object) continue;
    const base = 0.6;
    const confidence = rankingEnabled ? adjustedConfidence(base, 'user_experience') : base;
    addCompanyEdge(kernel, fact.subject, parsed.object, parsed.relation, {
      source: 'manual',
      sourceRef,
      sourceType: 'manual',
      evidenceType: 'user_experience',
      evidence: [text],
      confidence,
      sessionId: input.sessionId || '',
    });
    addCompanyEdge(kernel, noteNode, fact.subject, 'destekler', {
      source: 'manual',
      sourceRef,
      sourceType: 'manual',
      evidenceType: 'user_experience',
      evidence: [text],
      confidence,
      sessionId: input.sessionId || '',
    });
    added += 1;
  }

  if (added === 0) {
    addCompanyEdge(kernel, noteNode, text.slice(0, 96), 'not', {
      source: 'manual',
      sourceRef,
      sourceType: 'manual',
      evidenceType: 'user_experience',
      evidence: [text],
      confidence: rankingEnabled ? adjustedConfidence(0.45, 'user_experience') : 0.45,
      sessionId: input.sessionId || '',
    });
    added = 1;
  }

  trackSuccess(kernel, 'manual', added);
  return {
    ok: true,
    sourceType: 'manual',
    sourceRef,
    added,
  };
}

function ingestDecision(kernel, input = {}) {
  const title = String(input.title || '').trim();
  const rationale = String(input.rationale || '').trim();
  if (!title || !rationale) {
    return { ok: false, error: 'decision title and rationale are required' };
  }

  const date = String(input.date || nowIso().slice(0, 10)).trim();
  const decidedBy = String(input.decidedBy || 'unknown').trim();
  const sourceRef = `manual:${decidedBy}:${date}`;
  const decisionId = `decision:${slug(title)}:${date}`;
  const rationaleId = `decision-rationale:${slug(title)}:${date}`;

  addCompanyEdge(kernel, decisionId, rationaleId, 'açıklar', {
    source: 'manual',
    sourceRef,
    sourceType: 'manual',
    evidenceType: 'docs',
    evidence: [rationale],
    confidence: 0.78,
    sessionId: input.sessionId || '',
  });

  const alternatives = Array.isArray(input.alternatives) ? input.alternatives : [];
  for (const alt of alternatives) {
    const altId = `alternative:${slug(alt)}:${date}`;
    addCompanyEdge(kernel, decisionId, altId, 'alternatif', {
      source: 'manual',
      sourceRef,
      sourceType: 'manual',
      evidenceType: 'docs',
      evidence: [alt],
      confidence: 0.62,
      sessionId: input.sessionId || '',
    });
  }

  const links = Array.isArray(input.links) ? input.links : [];
  for (const link of links) {
    addCompanyEdge(kernel, decisionId, String(link), 'decides', {
      source: 'manual',
      sourceRef,
      sourceType: 'manual',
      evidenceType: 'docs',
      evidence: [title],
      confidence: 0.8,
      sessionId: input.sessionId || '',
    });
  }

  trackSuccess(kernel, 'manual', 1);
  return {
    ok: true,
    sourceType: 'decision',
    decisionId,
    sourceRef,
    added: 1,
  };
}

function getIngestStatus(kernel) {
  const state = ensureCompanyState(kernel);
  const stats = kernel.graph && typeof kernel.graph.getStats === 'function'
    ? kernel.graph.getStats()
    : { nodes: 0, edges: 0 };

  return {
    ok: true,
    totalNodes: stats.nodes || 0,
    distribution: {
      repo: Number(state.bySource.repo || 0),
      markdown: Number(state.bySource.markdown || 0),
      manual: Number(state.bySource.manual || 0),
    },
    lastIngestAt: state.lastIngestAt || null,
    ingestErrors: Array.isArray(state.ingestErrors) ? state.ingestErrors : [],
  };
}

function createCompanyBrainPlugin() {
  return {
    name: 'company-brain',
    version: '0.1.0',
    requires: ['graph', 'companyMode'],
    optional: ['llm', 'temporal', 'evidenceRanking', 'contradictionDetection'],
    capabilities: [
      {
        name: 'companyBrain',
        command: 'company-brain',
        description: 'Handles company memory manual ingest, decision logs, and graph-backed company queries.',
      },
      {
        name: 'ingestStatus',
        command: 'ingest-status',
        description: 'Returns ingest distribution and failure logs.',
      },
    ],
    init() {
      if (!this.adapter) this.adapter = new LLMAdapter();
    },
    async run(kernel, input = {}, opts = {}) {
      const capabilityName = String(opts.capability?.name || '');
      const action = String(input.action || '').toLowerCase();

      if (capabilityName === 'ingestStatus' || action === 'status') {
        return getIngestStatus(kernel);
      }

      try {
        if (action === 'ingestmanual' || action === 'manual' || input.sourceType === 'manual') {
          return ingestManual(kernel, input);
        }
        if (action === 'decision' || action === 'logdecision' || input.sourceType === 'decision') {
          return ingestDecision(kernel, input);
        }
        return await queryCompanyBrain(kernel, this, input);
      } catch (err) {
        trackError(kernel, input.sourceType || action || 'manual', err.message || String(err));
        return {
          ok: false,
          error: err.message || String(err),
          code: err.code || 'COMPANY_BRAIN_FAILED',
        };
      }
    },
  };
}

module.exports = createCompanyBrainPlugin();
module.exports.create = createCompanyBrainPlugin;
module.exports._test = {
  ensureCompanyState,
  ingestManual,
  ingestDecision,
  getIngestStatus,
};
