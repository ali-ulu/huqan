"use strict";

// Ingest side of plugins/company-brain.js (#2120): edge writing, proposal
// summaries and the manual / decision / API ingest use cases. Moved verbatim;
// shared state comes from lib/company-brain-state.js and entity meta
// from lib/company-brain-query.js.
const { adjustedConfidence } = require('../evidence-ranker');
const { identityKey, fallbackTargetId } = require('./company-brain-identity');
const { gateCompanyIngest } = require('./company-ingest-gate');
const { withCausalStrength } = require('./causal-edge-strength');
const { nowIso, trackSuccess } = require('./company-brain-state');
const { buildEntityResolutionMeta, ingestManualKnownNodes } = require('./company-brain-query');

function addCompanyEdge(kernel, fromId, toId, relation, opts = {}) {
  const proposals = [
    kernel.proposeNode(fromId, fromId),
    kernel.proposeNode(toId, toId),
  ];
  // Causal relations are refused by graph.js::addEdge without a strength, and
  // refused by throwing: manual and decision ingest died on every CAUSES /
  // PREVENTS / ENABLES / DEPENDS_ON sentence, after proposeNode had already
  // written the endpoints, leaving orphan nodes and no edge.
  const edgeResult = kernel.proposeEdge(fromId, toId, relation, withCausalStrength(relation, {
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
    strength: opts.strength,
    meta: opts.meta,
  }));
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

function ingestManual(kernel, input = {}) {
  const text = String(input.text || '').trim();
  if (!text) return { ok: false, error: 'manual ingest text is required' };

  const author = String(input.author || 'unknown').trim() || 'unknown';
  const date = String(input.date || nowIso().slice(0, 10)).trim() || nowIso().slice(0, 10);
  const sourceRef = `manual:${author}:${date}`;
  // The whole note text feeds the identity: keying on its first 24 characters
  // merged two same-day notes by the same author that merely started alike.
  const noteNode = `manual-note:${author}:${date}:${identityKey(text)}`;

  const proposals = [kernel.proposeNode(noteNode, noteNode)];
  const facts = typeof kernel.extractFacts === 'function'
    ? (kernel.extractFacts(text, ingestManualKnownNodes(kernel)) || [])
    : [];

  let added = 0;
  let matchedFacts = 0;
  const rankingEnabled = kernel.hasCapability && kernel.hasCapability('evidenceRanking');
  for (const fact of facts) {
    const parsed = typeof kernel.parsePredicate === 'function' ? kernel.parsePredicate(fact.predicate) : null;
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
    // Both edges are counted, matching ingestDecision and the repo-memory
    // connectors. Counting only `factEdge` under-reported `added`, and since
    // the same number feeds trackSuccess, `ingestStatus.distribution.manual`
    // ran low with every fact-bearing note.
    if (factEdge.edge) added += 1;
    if (evidenceEdge.edge) added += 1;
  }

  if (matchedFacts === 0) {
    const fallbackEdge = addCompanyEdge(kernel, noteNode, fallbackTargetId(text), 'not', {
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
  const decisionKey = identityKey(title, date, decidedBy);
  const decisionId = `decision:${decisionKey}:${date}`;
  const rationaleId = `decision-rationale:${decisionKey}:${date}`;

  const proposals = [];
  // Every edge this function writes is counted, not just the rationale one.
  // `added` fed both the return value and trackSuccess, so a decision with
  // alternatives and links reported at most 1 and the `decision` share of
  // ingestStatus.distribution drifted low with every such ingest.
  let added = 0;
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
  if (rationaleEdge.edge) added += 1;

  const alternatives = Array.isArray(input.alternatives) ? input.alternatives : [];
  for (const alt of alternatives) {
    const altId = `alternative:${identityKey(alt, date)}:${date}`;
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
    if (alternativeEdge.edge) added += 1;
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
    if (linkEdge.edge) added += 1;
  }

  trackSuccess(kernel, 'decision', added);
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
  const noteNode = `api-note:${identityKey(sourceRef)}:${date}`;
  const proposals = [];

  const edge = addCompanyEdge(kernel, noteNode, fallbackTargetId(text, 'api-note'), 'not', {
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

module.exports = {
  addCompanyEdge,
  summarizeProposals,
  ingestManual,
  ingestDecision,
  ingestApi,
};
