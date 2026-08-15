const LLMAdapter = require('../llmAdapter');
const { adjustedConfidence } = require('../evidence-ranker');
const { normalizeAlias, resolveEntity } = require('../lib/entity-resolution');
const { gateCompanyIngest } = require('../lib/company-ingest-gate');

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
  const proposals = [
    kernel.proposeNode(fromId, fromId),
    kernel.proposeNode(toId, toId),
  ];
  const edgeResult = kernel.proposeEdge(fromId, toId, relation, {
    source: opts.source || 'manual',
    sourceRef: opts.sourceRef || '',
    sessionId: opts.sessionId || '',
    sourceType: opts.sourceType || 'manual',
    // Forwarded so a pinned ingest keeps its pin: proposeEdge picks these up
    // through provenanceFieldsFrom and they land on the edge's provenance.
    sourceVersion: opts.sourceVersion || '',
    sourceVersionKind: opts.sourceVersionKind || '',
    contentHash: opts.contentHash || '',
    companyMode: true,
    evidenceType: opts.evidenceType || 'user_experience',
    evidence: Array.isArray(opts.evidence) ? opts.evidence : [],
    confidence: typeof opts.confidence === 'number' ? opts.confidence : 0.65,
    meta: opts.meta,
  });
  proposals.push(edgeResult);
  return {
    edge: edgeResult && edgeResult.edge ? edgeResult.edge : null,
    proposals,
  };
}

function summarizeProposals(proposals = []) {
  const list = proposals.flat().filter(Boolean);
  const counts = list.reduce((acc, proposal) => {
    const decision = proposal.decision || 'unknown';
    acc[decision] = (acc[decision] || 0) + 1;
    return acc;
  }, {});
  const outcome = counts.reject > 0
    ? 'reject'
    : counts.review > 0
      ? 'review'
      : counts.allow > 0
        ? 'allow'
        : 'unknown';
  return {
    outcome,
    graphWrite: list.some(proposal => Boolean(proposal.node || proposal.edge)),
    counts,
    total: list.length,
    evidence: list.map(proposal => ({
      workspaceId: proposal.admission?.workspaceId || proposal.audit?.workspaceId || '',
      receiptId: proposal.admission?.receiptId || '',
      auditId: proposal.audit?.auditId || '',
      graphWrite: Boolean(proposal.node || proposal.edge),
    })),
  };
}

function extractOriginalLiteral(text, normalizedSubject) {
  const raw = String(text || '').trim();
  if (!raw || !normalizedSubject) return raw;

  const words = raw.split(/\s+/).filter(Boolean);
  if (words.length === 0) return raw;

  const filtered = words.filter(word => {
    const lowered = normalizeAlias(word);
    return lowered !== 'bir' && lowered !== 'de' && lowered !== 'da';
  });

  for (let len = Math.min(3, filtered.length); len >= 1; len--) {
    const candidate = filtered.slice(0, len).join(' ');
    if (normalizeAlias(candidate) === normalizeAlias(normalizedSubject)) {
      return candidate;
    }
  }

  return filtered[0] || raw;
}

function buildEntityResolutionMeta(text, subject, domain) {
  if (!domain) return null;

  const originalLiteral = extractOriginalLiteral(text, subject);
  const resolution = resolveEntity(originalLiteral, { domain });
  if (!resolution.matched || resolution.ambiguous) return null;

  return {
    entityResolution: {
      originalLiteral,
      canonicalId: resolution.canonical,
      domain: resolution.domain,
      matched: true,
      ambiguous: false,
      confidence: resolution.confidence ?? 1,
      reason: resolution.reason || 'exact_alias',
      aliases: Array.isArray(resolution.aliases) ? [...resolution.aliases] : [],
    },
  };
}

function extractTokens(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^a-z0-9çğıöşü_:/.-]+/i)
    .map(item => item.trim())
    .filter(item => item.length >= 3);
}

// REFACTOR-4D AC-5.5 (Package 03 — 03A queryCompanyBrain):
// Migrate private `kernel.graph?._nodes` access to the public
// `graph.getNodes(workspaceId)` API. `queryCompanyBrain` is a dynamic-
// workspace use case (Bölüm 4.2.1 of decision-4d-graph-workspace-contract.md):
// `input.workspaceId || 'default'` is forwarded to `getNodes`, so tenant
// callers see tenant nodes and default callers see default nodes. AC-5.3
// parity is preserved — the public API applies the same workspace filter
// the inline loop previously applied, so the observable set of ranked
// matches is unchanged for every workspace value.
//
// `extractFacts` (used by 03B below) accepts either an object (uses
// `Object.keys`) or an array; both `_nodes` and `getNodes(<ws>)` return
// `{id: node}` maps, so the observable behavior is preserved.
//
// Fallback to `kernel.graph?._nodes` is retained ONLY for legacy test
// harnesses and mock kernels that construct a graph without `getNodes`.
// Real `Graph` instances always expose `getNodes`, so the fallback never
// runs in production. See docs/refactor/refactor-4d-contract-acceptance.md
// AC-5.3 + AC-5.5 and docs/refactor/decision-4d-graph-workspace-contract.md
// (Bölüm 4.2.1 — queryCompanyBrain dynamic-workspace target, BINDING).
function queryCompanyBrainKnownNodes(kernel, workspaceId = 'default') {
  if (!kernel) return {};
  if (kernel.graph && typeof kernel.graph.getNodes === 'function') {
    return kernel.graph.getNodes(workspaceId);
  }
  return kernel.graph?._nodes || {};
}

// REFACTOR-4D AC-5.5 (Package 03 — 03B ingestManual):
// `ingestManual` does NOT read `input.workspaceId` (Bölüm 4.2.2 of
// decision-4d-graph-workspace-contract.md). Pre-migration it passed the
// raw `_nodes` map (all workspaces) to `extractFacts`. Post-migration it
// passes `getNodes('default')` — an INTENTIONAL DEFAULT-WORKSPACE
// NARROWING, not parity. This narrowing is authorized by
// docs/refactor/acceptance-amendment-4d-ingestmanual-narrowing.md under
// the AC-5.3a narrow exception (8 conditions). Three mutation guards
// (raw `_nodes` restored, `getNodes('tenant-a')` used, workspace filter
// removed) must all RED — see Bölüm 5.4 / Bölüm 9.1 koşul 6 of the
// amendment. Fallback to `_nodes` retained for legacy test harnesses
// only; the legacy fallback is covered by a SEPARATE compatibility test
// (NOT part of the narrowing assertion) per Bölüm 5.5 of the amendment.
function ingestManualKnownNodes(kernel) {
  if (!kernel) return {};
  if (kernel.graph && typeof kernel.graph.getNodes === 'function') {
    return kernel.graph.getNodes('default');
  }
  return kernel.graph?._nodes || {};
}

function rankGraphMatches(kernel, tokens, workspaceId = null) {
  const knownNodes = queryCompanyBrainKnownNodes(kernel, workspaceId || 'default');
  const nodes = Object.values(knownNodes);
  const scored = [];
  for (const node of nodes) {
    if (workspaceId && (node.workspaceId || 'default') !== workspaceId) continue;
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
  const seen = new Set();
  for (const match of matches) {
    const workspaceId = match.node?.workspaceId || 'default';
    const outgoing = kernel.graph.getEdges(match.node.id, workspaceId) || [];
    const incoming = kernel.graph.getInEdges(match.node.id, workspaceId) || [];
    for (const edge of [...outgoing.slice(0, 4), ...incoming.slice(0, 4)]) {
      const sourceRef = edge.source_ref || edge.sourceRef || '';
      const sourceType = edge.source_type || edge.sourceType || '';
      const confidence = edge.confidence ?? edge.weight ?? 0.5;
      const evidenceKey = [
        edge.from,
        edge.relation,
        edge.to,
        sourceRef,
        sourceType,
        edge.workspaceId || workspaceId,
      ].join('|');
      if (seen.has(evidenceKey)) continue;
      seen.add(evidenceKey);
      evidence.push({
        from: edge.from,
        relation: edge.relation,
        to: edge.to,
        source_ref: sourceRef,
        source_type: sourceType,
        confidence,
        workspaceId: edge.workspaceId || workspaceId,
        provenance: edge.provenance || null,
      });
      if (sourceRef) sourceRefs.add(sourceRef);
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
  const workspaceId = String(input.workspaceId || 'default').trim() || 'default';
  const matches = rankGraphMatches(kernel, tokens, workspaceId);
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

  const proposals = [kernel.proposeNode(noteNode, noteNode)];
  const facts = typeof kernel.extractFacts === 'function'
    ? (kernel.extractFacts(text, ingestManualKnownNodes(kernel)) || [])
    : [];

  let added = 0;
  let matchedFacts = 0;
  const rankingEnabled = kernel.hasCapability && kernel.hasCapability('evidenceRanking');
  for (const fact of facts) {
    const parsed = typeof kernel._parsePredicate === 'function' ? kernel._parsePredicate(fact.predicate) : null;
    if (!parsed || !fact.subject || !parsed.object) continue;
    matchedFacts += 1;
    const base = 0.6;
    const confidence = rankingEnabled ? adjustedConfidence(base, 'user_experience') : base;
    const entityMeta = buildEntityResolutionMeta(text, fact.subject, input.domain);
    const factEdge = addCompanyEdge(kernel, fact.subject, parsed.object, parsed.relation, {
      source: 'manual',
      sourceRef,
      sourceType: 'manual',
      evidenceType: 'user_experience',
      evidence: [text],
      confidence,
      sessionId: input.sessionId || '',
      meta: entityMeta,
    });
    const evidenceEdge = addCompanyEdge(kernel, noteNode, fact.subject, 'destekler', {
      source: 'manual',
      sourceRef,
      sourceType: 'manual',
      evidenceType: 'user_experience',
      evidence: [text],
      confidence,
      sessionId: input.sessionId || '',
      meta: entityMeta,
    });
    proposals.push(...factEdge.proposals, ...evidenceEdge.proposals);
    if (factEdge.edge) added += 1;
  }

  if (matchedFacts === 0) {
    const fallbackEdge = addCompanyEdge(kernel, noteNode, text.slice(0, 96), 'not', {
      source: 'manual',
      sourceRef,
      sourceType: 'manual',
      evidenceType: 'user_experience',
      evidence: [text],
      confidence: rankingEnabled ? adjustedConfidence(0.45, 'user_experience') : 0.45,
      sessionId: input.sessionId || '',
    });
    proposals.push(...fallbackEdge.proposals);
    if (fallbackEdge.edge) added = 1;
  }

  trackSuccess(kernel, 'manual', added);
  return {
    ok: true,
    sourceType: 'manual',
    sourceRef,
    added,
    admission: summarizeProposals(proposals),
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

  const proposals = [];
  const rationaleEdge = addCompanyEdge(kernel, decisionId, rationaleId, 'açıklar', {
    source: 'manual',
    sourceRef,
    sourceType: 'manual',
    evidenceType: 'docs',
    evidence: [rationale],
    confidence: 0.78,
    sessionId: input.sessionId || '',
  });
  proposals.push(...rationaleEdge.proposals);

  const alternatives = Array.isArray(input.alternatives) ? input.alternatives : [];
  for (const alt of alternatives) {
    const altId = `alternative:${slug(alt)}:${date}`;
    const alternativeEdge = addCompanyEdge(kernel, decisionId, altId, 'alternatif', {
      source: 'manual',
      sourceRef,
      sourceType: 'manual',
      evidenceType: 'docs',
      evidence: [alt],
      confidence: 0.62,
      sessionId: input.sessionId || '',
    });
    proposals.push(...alternativeEdge.proposals);
  }

  const links = Array.isArray(input.links) ? input.links : [];
  for (const link of links) {
    const linkEdge = addCompanyEdge(kernel, decisionId, String(link), 'decides', {
      source: 'manual',
      sourceRef,
      sourceType: 'manual',
      evidenceType: 'docs',
      evidence: [title],
      confidence: 0.8,
      sessionId: input.sessionId || '',
    });
    proposals.push(...linkEdge.proposals);
  }

  const added = rationaleEdge.edge ? 1 : 0;
  trackSuccess(kernel, 'manual', added);
  return {
    ok: true,
    sourceType: 'decision',
    decisionId,
    sourceRef,
    added,
    admission: summarizeProposals(proposals),
  };
}


/**
 * Ingest content pulled from an external system on the company's behalf.
 *
 * Separate from ingestManual because the trust situation is different, not
 * because the storage is. A person typing a note has read what they are typing;
 * an API pull has not been read by anyone, so whatever the other system happens
 * to hold -- a token pasted into a wiki page, a customer ID in a ticket --
 * arrives with it. Everything here goes through gateCompanyIngest first, and
 * only the scrubbed text continues.
 *
 * The caller supplies the content. Fetching is the adapters' job; this is the
 * seam where fetched content becomes company memory.
 */
function ingestApi(kernel, input = {}) {
  const sourceRef = String(input.sourceRef || '').trim();
  if (!sourceRef) {
    const err = new Error('API ingest requires a sourceRef naming what was read');
    err.code = 'COMPANY_BRAIN_SOURCE_REF_REQUIRED';
    throw err;
  }

  const gate = gateCompanyIngest(String(input.text || ''));

  // `gate.text`, never `input.text`. Reaching past the gate here is the whole
  // failure mode, and it would still pass a test that only counted gate calls.
  const text = gate.text;
  if (!text.trim()) {
    return {
      ok: true,
      sourceType: 'api',
      sourceRef,
      added: 0,
      reason: 'nothing_left_after_gates',
      gates: gate.gateVersions,
      secretDetected: gate.secretDetected,
      piiDetected: gate.piiDetected,
      piiTypes: gate.piiTypes,
      admission: summarizeProposals([]),
    };
  }

  const date = String(input.date || new Date().toISOString().slice(0, 10));
  const noteNode = `api-note:${slug(sourceRef)}:${date}`;
  const proposals = [];

  const edge = addCompanyEdge(kernel, noteNode, text.slice(0, 96), 'not', {
    source: 'api',
    sourceRef,
    sourceType: 'api',
    evidenceType: 'docs',
    evidence: [text.slice(0, 240)],
    sessionId: input.sessionId || '',
    // Provenance fields, not edge meta: edge meta is namespaced to
    // entityResolution by contract, and where a claim came from is provenance's
    // job anyway. proposeEdge forwards these through provenanceFieldsFrom.
    sourceVersion: input.sourceVersion || '',
    sourceVersionKind: input.sourceVersionKind || '',
    contentHash: input.contentHash || '',
  });
  proposals.push(...edge.proposals);

  trackSuccess(kernel, 'api', edge.edge ? 1 : 0);
  return {
    ok: true,
    sourceType: 'api',
    sourceRef,
    added: edge.edge ? 1 : 0,
    gates: gate.gateVersions,
    secretDetected: gate.secretDetected,
    piiDetected: gate.piiDetected,
    piiTypes: gate.piiTypes,
    admission: summarizeProposals(proposals),
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
        if (action === 'ingestapi' || action === 'api' || input.sourceType === 'api') {
          return ingestApi(kernel, input);
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
  ingestApi,
  getIngestStatus,
};
