'use strict';

// Workflow tools that read the kernel directly rather than through a
// capability runner: verifyClaim, findContradictions, rankEvidence and
// getGraphStats (#2133).

const { adjustedConfidence, rankEvidence, WEIGHTS } = require('../evidence-ranker');
const { normalizeConfidence } = require('./workflow-values');
const { cloneValue, normalizeToolInput, buildEnvelope, resultFromKernel } = require('./workflow-tool-envelope');

function createVerifyClaimTool(kernel) {
  return {
    name: 'verifyClaim',
    description: 'Verify a claim with the AXIOM kernel.',
    inputSchema: {
      type: 'object',
      properties: {
        statement: { type: 'string' },
        opts: { type: 'object' },
      },
      required: ['statement'],
    },
    run(context = {}, input = {}) {
      if (!kernel || typeof kernel.verify !== 'function') {
        return buildEnvelope({
          ok: false,
          tool: 'verifyClaim',
          status: 'error',
          data: { status: 'unknown' },
          error: { code: 'MISSING_METHOD', message: 'kernel.verify is unavailable.' },
          confidence: 0,
        });
      }
      const payload = normalizeToolInput(input);
      const statement = payload.statement || payload.text || payload.value || '';
      const opts = payload.opts && typeof payload.opts === 'object' ? payload.opts : context.opts || {};
      const result = kernel.verify(statement, opts);
      const data = result && result.data ? {
        ...result.data,
        claim: statement,
      } : {
        claim: statement,
      };
      return resultFromKernel('verifyClaim', result, data, {
        source: 'kernel.verify',
        claim: statement,
      });
    },
  };
}

function createFindContradictionsTool(kernel) {
  return {
    name: 'findContradictions',
    description: 'Find contradictions in the current graph.',
    inputSchema: {
      type: 'object',
      properties: {
        subject: { type: 'string' },
      },
    },
    run(context = {}, input = {}) {
      if (!kernel || typeof kernel.detectContradictions !== 'function') {
        return buildEnvelope({
          ok: false,
          tool: 'findContradictions',
          status: 'error',
          data: { contradictions: [] },
          error: { code: 'MISSING_METHOD', message: 'kernel.detectContradictions is unavailable.' },
          confidence: 0,
        });
      }
      const payload = normalizeToolInput(input);
      const contradictions = kernel.detectContradictions(payload.subject || context.subject || payload.text || '', payload.workspaceId || context.workspaceId || context.opts?.workspaceId || 'default');
      const normalized = Array.isArray(contradictions) ? contradictions : [];
      return buildEnvelope({
        ok: true,
        tool: 'findContradictions',
        status: 'done',
        data: {
          contradictions: cloneValue(normalized),
          count: normalized.length,
        },
        evidence: normalized.map(item => ({
          kind: item.type || 'contradiction',
          text: item.description || item.message || item.reason || JSON.stringify(item),
          confidence: normalizeConfidence(item.confidence, 0.5),
          contradiction: cloneValue(item),
        })),
        confidence: normalized.length > 0 ? 0.75 : 0.45,
        meta: {
          source: 'kernel.detectContradictions',
        },
      });
    },
  };
}

function createRankEvidenceTool() {
  return {
    name: 'rankEvidence',
    description: 'Rank evidence items and compute adjusted confidence.',
    inputSchema: {
      type: 'object',
      properties: {
        evidence: { type: 'array' },
        baseConfidence: { type: 'number' },
        type: { type: 'string' },
      },
    },
    run(context = {}, input = {}) {
      const payload = normalizeToolInput(input);
      const evidence = Array.isArray(payload.evidence)
        ? payload.evidence
        : (payload.evidence ? [payload.evidence] : []);
      const baseConfidence = Number.isFinite(Number(payload.baseConfidence))
        ? Number(payload.baseConfidence)
        : Number.isFinite(Number(context.baseConfidence))
          ? Number(context.baseConfidence)
          : 0.5;
      const type = payload.type || context.type || (evidence[0] && (evidence[0].type || evidence[0].kind)) || 'user_opinion';

      const ranked = evidence
        .map(item => {
          const itemType = item && (item.type || item.kind) ? item.type || item.kind : type;
          const base = Number.isFinite(Number(item?.confidence)) ? Number(item.confidence) : baseConfidence;
          return {
            ...cloneValue(item),
            type: itemType,
            weight: rankEvidence(itemType),
            adjustedConfidence: adjustedConfidence(base, itemType),
          };
        })
        .sort((a, b) => (b.adjustedConfidence ?? 0) - (a.adjustedConfidence ?? 0));

      const overall = ranked.length
        ? ranked.reduce((sum, item) => sum + (item.adjustedConfidence ?? 0), 0) / ranked.length
        : adjustedConfidence(baseConfidence, type);

      return buildEnvelope({
        ok: true,
        tool: 'rankEvidence',
        status: 'done',
        data: {
          evidence: ranked,
          baseConfidence,
          type,
          weights: WEIGHTS,
          adjustedConfidence: normalizeConfidence(overall, baseConfidence),
        },
        evidence: ranked,
        confidence: normalizeConfidence(overall, baseConfidence),
        meta: {
          source: 'evidence-ranker',
        },
      });
    },
  };
}

function createGraphStatsTool(kernel) {
  return {
    name: 'getGraphStats',
    description: 'Return graph statistics from the kernel graph.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
    run(context = {}, input = {}) {
      if (!kernel || !kernel.graph || typeof kernel.graph.getStats !== 'function') {
        return buildEnvelope({
          ok: false,
          tool: 'getGraphStats',
          status: 'error',
          data: null,
          error: { code: 'MISSING_METHOD', message: 'kernel.graph.getStats is unavailable.' },
          confidence: 0,
        });
      }
      const stats = kernel.graph.getStats();
      return buildEnvelope({
        ok: true,
        tool: 'getGraphStats',
        status: 'done',
        data: {
          stats: cloneValue(stats),
          graph: cloneValue(stats),
        },
        evidence: [],
        confidence: 0.8,
        meta: {
          source: 'kernel.graph.getStats',
        },
      });
    },
  };
}

module.exports = {
  createVerifyClaimTool,
  createFindContradictionsTool,
  createRankEvidenceTool,
  createGraphStatsTool,
};
