"use strict";

// Graph query side of plugins/company-brain.js (#2120): entity-resolution
// meta, known-node readers, match ranking, evidence collection and the
// query use case with its LLM fallback. Moved verbatim; the plugin entry
// keeps the capability wiring and the ingest side lives in
// lib/company-brain-ingest.js.
const { normalizeAlias, resolveEntity } = require('./entity-resolution');
const { extractTokens } = require('./company-brain-identity');

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
    const hay = normalizeAlias(`${node.id} ${node.label}`);
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

  // The adapter is ensured by the plugin entry before delegating here; without
  // one there is nothing to fall back to, so this degrades to manual review
  // (the same outcome as a kernel without the llm capability).
  if (kernel.hasCapability && kernel.hasCapability('llm') && plugin.adapter) {
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

module.exports = {
  extractOriginalLiteral,
  buildEntityResolutionMeta,
  queryCompanyBrainKnownNodes,
  ingestManualKnownNodes,
  rankGraphMatches,
  collectEvidenceFromMatches,
  describeEvidence,
  queryCompanyBrain,
};
