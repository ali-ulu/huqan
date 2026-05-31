const { adjustedConfidence, rankEvidence, WEIGHTS } = require('./evidence-ranker');
const {
  normalizeConfidence,
  normalizeEvidence,
  normalizeError,
} = require('./workflow-agent');

function cloneValue(value) {
  if (value === undefined) return undefined;
  return JSON.parse(JSON.stringify(value));
}

function normalizeToolInput(input) {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return { ...input };
  }
  if (typeof input === 'string') {
    return { text: input };
  }
  return { value: input };
}

function buildEnvelope({ ok, tool, status, data, evidence = [], confidence, error = null, meta = {} }) {
  const normalizedEvidence = normalizeEvidence(evidence);
  return {
    ok: Boolean(ok),
    tool,
    status,
    data: cloneValue(data),
    output: cloneValue(data),
    evidence: normalizedEvidence,
    confidence: normalizeConfidence(confidence, ok ? 0.5 : 0),
    error: error ? normalizeError(error, ok ? 'ERROR' : (error.code || 'ERROR'), error.message || 'Tool execution failed.') : null,
    trace: [{
      phase: 'adapter',
      tool,
      status,
      evidenceCount: normalizedEvidence.length,
      confidence: normalizeConfidence(confidence, ok ? 0.5 : 0),
    }],
    errors: error ? [normalizeError(error, error.code || 'ERROR', error.message || 'Tool execution failed.')] : [],
    meta: {
      tool,
      adapter: 'workflow-tools',
      ...meta,
    },
  };
}

function resultFromKernel(tool, kernelResult, fallbackData = null, meta = {}) {
  const hasEnvelope = kernelResult && typeof kernelResult === 'object' && Object.prototype.hasOwnProperty.call(kernelResult, 'ok');
  const ok = hasEnvelope ? Boolean(kernelResult.ok) : true;
  const rawData = hasEnvelope
    ? (kernelResult.data !== undefined ? kernelResult.data : kernelResult)
    : (kernelResult !== undefined ? kernelResult : fallbackData);
  const data = rawData && typeof rawData === 'object' && !Array.isArray(rawData) && fallbackData && typeof fallbackData === 'object' && !Array.isArray(fallbackData)
    ? { ...cloneValue(fallbackData), ...cloneValue(rawData) }
    : cloneValue(rawData);
  const evidence = hasEnvelope ? (kernelResult.evidence || []) : [];
  const confidence = hasEnvelope
    ? (kernelResult.data && typeof kernelResult.data.confidence === 'number'
      ? kernelResult.data.confidence
      : kernelResult.confidence ?? fallbackData?.confidence ?? 0.5)
    : (fallbackData && typeof fallbackData.confidence === 'number' ? fallbackData.confidence : 0.5);

  return buildEnvelope({
    ok,
    tool,
    status: ok ? 'done' : 'error',
    data,
    evidence,
    confidence,
    error: hasEnvelope ? kernelResult.error : null,
    meta,
  });
}


function createWorkflowTools(kernel) {
  const tools = [];

  tools.push({
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
          data: { status: 'bilinmiyor' },
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
  });

  tools.push({
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
      const contradictions = kernel.detectContradictions(payload.subject || context.subject || payload.text || '');
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
  });

  tools.push({
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
  });

  tools.push({
    name: 'runCapability',
    description: 'Execute a registered plugin capability through the kernel.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        input: { type: 'object' },
        opts: { type: 'object' },
      },
      required: ['name'],
    },
    async run(context = {}, input = {}) {
      if (!kernel || typeof kernel.runCapability !== 'function') {
        return buildEnvelope({
          ok: false,
          tool: 'runCapability',
          status: 'error',
          data: null,
          error: { code: 'MISSING_METHOD', message: 'kernel.runCapability is unavailable.' },
          confidence: 0,
        });
      }

      const payload = normalizeToolInput(input);
      const capabilityName = payload.name || payload.capability || context.name || '';
      const capabilityInput = payload.input !== undefined ? payload.input : context.input;
      const opts = payload.opts && typeof payload.opts === 'object' ? payload.opts : context.opts || {};

      try {
        const result = await kernel.runCapability(capabilityName, capabilityInput, opts);
        return resultFromKernel('runCapability', result, {
          capability: capabilityName,
          input: capabilityInput,
        }, {
          source: 'kernel.runCapability',
        });
      } catch (error) {
        return buildEnvelope({
          ok: false,
          tool: 'runCapability',
          status: 'error',
          data: {
            capability: capabilityName,
          },
          error,
          confidence: 0,
          meta: {
            source: 'kernel.runCapability',
          },
        });
      }
    },
  });

  tools.push({
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
  });

  return tools;
}

function registerDefaultWorkflowTools(registry, kernel) {
  if (!registry || typeof registry.registerTool !== 'function') {
    throw new Error('Registry with registerTool() is required.');
  }
  const tools = createWorkflowTools(kernel);
  for (const tool of tools) {
    registry.registerTool(tool);
  }
  return tools;
}

module.exports = {
  createWorkflowTools,
  registerDefaultWorkflowTools,
};
