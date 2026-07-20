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

function resolveCapabilityRunner(kernel) {
  if (kernel && typeof kernel.runCapability === 'function') {
    return {
      source: 'kernel.runCapability',
      run: kernel.runCapability.bind(kernel),
    };
  }
  if (kernel && kernel.plugins && typeof kernel.plugins.runCapability === 'function') {
    return {
      source: 'plugin-manager',
      run: kernel.plugins.runCapability.bind(kernel.plugins),
    };
  }
  return null;
}

function isUnavailableCapabilityError(error) {
  const message = String(error?.message || error || '');
  return /missing capability|unavailable|unknown plugin capability|unknown capability/i.test(message);
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
    name: 'repoMemory',
    description: 'Ingest GitHub repos or markdown sources into company memory through the repo-memory capability.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        sourceType: { type: 'string' },
        repoUrl: { type: 'string' },
        url: { type: 'string' },
        path: { type: 'string' },
        targetPath: { type: 'string' },
        branch: { type: 'string' },
        token: { type: 'string' },
        sessionId: { type: 'string' },
        opts: { type: 'object' },
      },
    },
    async run(context = {}, input = {}) {
      const runner = resolveCapabilityRunner(kernel);
      if (!runner) {
        return buildEnvelope({
          ok: false,
          tool: 'repoMemory',
          status: 'error',
          data: {
            sourceType: String(input.sourceType || context.sourceType || '').toLowerCase() || 'github',
          },
          error: { code: 'MISSING_METHOD', message: 'kernel.runCapability is unavailable.' },
          confidence: 0,
        });
      }

      const payload = normalizeToolInput(input);
      const action = String(payload.action || context.action || 'ingest').toLowerCase();
      const sourceType = String(payload.sourceType || context.sourceType || (payload.repoUrl || payload.url ? 'github' : payload.path || payload.targetPath ? 'markdown' : 'github')).toLowerCase();
      const opts = payload.opts && typeof payload.opts === 'object' ? payload.opts : context.opts || {};
      const request = {
        action,
        sourceType,
        repoUrl: payload.repoUrl || payload.url || context.repoUrl || context.url || '',
        url: payload.url || context.url || '',
        path: payload.path || payload.targetPath || context.path || context.targetPath || '',
        targetPath: payload.targetPath || context.targetPath || '',
        branch: payload.branch || context.branch || 'main',
        token: payload.token || context.token || '',
        sessionId: payload.sessionId || context.sessionId || '',
        author: payload.author || context.author || '',
        date: payload.date || context.date || '',
        text: payload.text || context.text || '',
      };

      try {
        const result = await runner.run('repoMemory', request, opts);
        return resultFromKernel('repoMemory', result, {
          sourceType,
          action,
        }, {
          source: runner.source,
          capability: 'repoMemory',
        });
      } catch (error) {
        return buildEnvelope({
          ok: false,
          tool: 'repoMemory',
          status: 'error',
          data: {
            sourceType,
            action,
          },
          error,
          confidence: 0,
          meta: {
            source: runner.source,
            capability: 'repoMemory',
          },
        });
      }
    },
  });

  tools.push({
    name: 'companyBrain',
    description: 'Query or ingest company memory through the company-brain capability.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string' },
        question: { type: 'string' },
        text: { type: 'string' },
        sourceType: { type: 'string' },
        title: { type: 'string' },
        rationale: { type: 'string' },
        decidedBy: { type: 'string' },
        date: { type: 'string' },
        links: { type: 'array' },
        alternatives: { type: 'array' },
        sessionId: { type: 'string' },
        opts: { type: 'object' },
      },
    },
    async run(context = {}, input = {}) {
      const runner = resolveCapabilityRunner(kernel);
      if (!runner) {
        return buildEnvelope({
          ok: false,
          tool: 'companyBrain',
          status: 'unavailable',
          data: {
            source: 'company-brain',
            capability: 'companyBrain',
            input: cloneValue(normalizeToolInput(input)),
          },
          error: { code: 'MISSING_METHOD', message: 'companyBrain capability unavailable' },
          confidence: 0,
          meta: {
            source: 'company-brain',
            capability: 'companyBrain',
          },
        });
      }

      const payload = normalizeToolInput(input);
      const action = String(payload.action || context.action || (payload.question || payload.text ? 'query' : 'query')).toLowerCase();
      const sourceType = String(payload.sourceType || context.sourceType || '').toLowerCase();
      const opts = payload.opts && typeof payload.opts === 'object' ? payload.opts : context.opts || {};
      const request = {
        action,
        question: payload.question || context.question || '',
        text: payload.text || context.text || '',
        sourceType,
        title: payload.title || context.title || '',
        rationale: payload.rationale || context.rationale || '',
        decidedBy: payload.decidedBy || context.decidedBy || '',
        date: payload.date || context.date || '',
        links: Array.isArray(payload.links) ? payload.links : (Array.isArray(context.links) ? context.links : []),
        alternatives: Array.isArray(payload.alternatives) ? payload.alternatives : (Array.isArray(context.alternatives) ? context.alternatives : []),
        sessionId: payload.sessionId || context.sessionId || '',
        input: cloneValue(payload),
      };

      try {
        const result = await runner.run('companyBrain', request, opts);
        if (result && result.ok === false && isUnavailableCapabilityError(result.error)) {
          return buildEnvelope({
            ok: false,
            tool: 'companyBrain',
            status: 'unavailable',
            data: {
              source: 'company-brain',
              capability: 'companyBrain',
              input: request,
            },
            error: { code: 'CAPABILITY_UNAVAILABLE', message: 'companyBrain capability unavailable' },
            confidence: 0,
            meta: {
              source: 'company-brain',
              capability: 'companyBrain',
            },
          });
        }
        return resultFromKernel('companyBrain', result, {
          source: 'company-brain',
          capability: 'companyBrain',
          input: request,
        }, {
          source: 'company-brain',
          capability: 'companyBrain',
        });
      } catch (error) {
        return buildEnvelope({
          ok: false,
          tool: 'companyBrain',
          status: 'unavailable',
          data: {
            source: 'company-brain',
            capability: 'companyBrain',
            input: request,
          },
          error,
          confidence: 0,
          meta: {
            source: 'company-brain',
            capability: 'companyBrain',
          },
        });
      }
    },
  });

  tools.push({
    name: 'discoveryEngine',
    description: 'Run the discovery engine skeleton through the kernel.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        hypothesis: { type: 'string' },
        text: { type: 'string' },
        opts: { type: 'object' },
      },
    },
    async run(context = {}, input = {}) {
      const runner = resolveCapabilityRunner(kernel);
      if (!runner) {
        return buildEnvelope({
          ok: false,
          tool: 'discoveryEngine',
          status: 'unavailable',
          data: {
            source: 'discovery-engine',
            capability: 'discoveryEngine',
            input: cloneValue(normalizeToolInput(input)),
          },
          error: { code: 'MISSING_METHOD', message: 'discoveryEngine capability unavailable' },
          confidence: 0,
          meta: {
            source: 'discovery-engine',
            capability: 'discoveryEngine',
          },
        });
      }

      const payload = normalizeToolInput(input);
      const request = {
        goal: payload.goal || context.goal || '',
        hypothesis: payload.hypothesis || context.hypothesis || '',
        text: payload.text || context.text || '',
        opts: payload.opts && typeof payload.opts === 'object' ? payload.opts : context.opts || {},
        input: cloneValue(payload),
      };

      try {
        const result = await runner.run('discoveryEngine', request, request.opts);
        if (result && result.ok === false && isUnavailableCapabilityError(result.error)) {
          return buildEnvelope({
            ok: false,
            tool: 'discoveryEngine',
            status: 'unavailable',
            data: {
              source: 'discovery-engine',
              capability: 'discoveryEngine',
              input: request,
            },
            error: { code: 'CAPABILITY_UNAVAILABLE', message: 'discoveryEngine capability unavailable' },
            confidence: 0,
            meta: {
              source: 'discovery-engine',
              capability: 'discoveryEngine',
            },
          });
        }
        return resultFromKernel('discoveryEngine', result, {
          source: 'discovery-engine',
          capability: 'discoveryEngine',
          input: request,
        }, {
          source: 'discovery-engine',
          capability: 'discoveryEngine',
        });
      } catch (error) {
        return buildEnvelope({
          ok: false,
          tool: 'discoveryEngine',
          status: 'unavailable',
          data: {
            source: 'discovery-engine',
            capability: 'discoveryEngine',
            input: request,
          },
          error,
          confidence: 0,
          meta: {
            source: 'discovery-engine',
            capability: 'discoveryEngine',
          },
        });
      }
    },
  });

  tools.push({
    name: 'experimentPlanner',
    description: 'Create an experiment plan for a discovery hypothesis.',
    inputSchema: {
      type: 'object',
      properties: {
        goal: { type: 'string' },
        hypothesis: { type: 'string' },
        text: { type: 'string' },
        opts: { type: 'object' },
      },
    },
    async run(context = {}, input = {}) {
      const runner = resolveCapabilityRunner(kernel);
      if (!runner) {
        return buildEnvelope({
          ok: false,
          tool: 'experimentPlanner',
          status: 'unavailable',
          data: {
            source: 'experiment-planner',
            capability: 'experimentPlanner',
            input: cloneValue(normalizeToolInput(input)),
          },
          error: { code: 'MISSING_METHOD', message: 'experimentPlanner capability unavailable' },
          confidence: 0,
          meta: {
            source: 'experiment-planner',
            capability: 'experimentPlanner',
          },
        });
      }

      const payload = normalizeToolInput(input);
      const request = {
        goal: payload.goal || context.goal || '',
        hypothesis: payload.hypothesis || context.hypothesis || '',
        text: payload.text || context.text || '',
        opts: payload.opts && typeof payload.opts === 'object' ? payload.opts : context.opts || {},
        input: cloneValue(payload),
      };

      try {
        const result = await runner.run('experimentPlanner', request, request.opts);
        if (result && result.ok === false && isUnavailableCapabilityError(result.error)) {
          return buildEnvelope({
            ok: false,
            tool: 'experimentPlanner',
            status: 'unavailable',
            data: {
              source: 'experiment-planner',
              capability: 'experimentPlanner',
              input: request,
            },
            error: { code: 'CAPABILITY_UNAVAILABLE', message: 'experimentPlanner capability unavailable' },
            confidence: 0,
            meta: {
              source: 'experiment-planner',
              capability: 'experimentPlanner',
            },
          });
        }
        return resultFromKernel('experimentPlanner', result, {
          source: 'experiment-planner',
          capability: 'experimentPlanner',
          input: request,
        }, {
          source: 'experiment-planner',
          capability: 'experimentPlanner',
        });
      } catch (error) {
        return buildEnvelope({
          ok: false,
          tool: 'experimentPlanner',
          status: 'unavailable',
          data: {
            source: 'experiment-planner',
            capability: 'experimentPlanner',
            input: request,
          },
          error,
          confidence: 0,
          meta: {
            source: 'experiment-planner',
            capability: 'experimentPlanner',
          },
        });
      }
    },
  });

  tools.push({
    name: 'resultAnalyzer',
    description: 'Analyze discovery results into a minimal evidence summary.',
    inputSchema: {
      type: 'object',
      properties: {
        result: { type: 'string' },
        observation: { type: 'string' },
        text: { type: 'string' },
        opts: { type: 'object' },
      },
    },
    async run(context = {}, input = {}) {
      const runner = resolveCapabilityRunner(kernel);
      if (!runner) {
        return buildEnvelope({
          ok: false,
          tool: 'resultAnalyzer',
          status: 'unavailable',
          data: {
            source: 'result-analyzer',
            capability: 'resultAnalyzer',
            input: cloneValue(normalizeToolInput(input)),
          },
          error: { code: 'MISSING_METHOD', message: 'resultAnalyzer capability unavailable' },
          confidence: 0,
          meta: {
            source: 'result-analyzer',
            capability: 'resultAnalyzer',
          },
        });
      }

      const payload = normalizeToolInput(input);
      const request = {
        result: payload.result || context.result || '',
        observation: payload.observation || context.observation || '',
        text: payload.text || context.text || '',
        opts: payload.opts && typeof payload.opts === 'object' ? payload.opts : context.opts || {},
        input: cloneValue(payload),
      };

      try {
        const result = await runner.run('resultAnalyzer', request, request.opts);
        if (result && result.ok === false && isUnavailableCapabilityError(result.error)) {
          return buildEnvelope({
            ok: false,
            tool: 'resultAnalyzer',
            status: 'unavailable',
            data: {
              source: 'result-analyzer',
              capability: 'resultAnalyzer',
              input: request,
            },
            error: { code: 'CAPABILITY_UNAVAILABLE', message: 'resultAnalyzer capability unavailable' },
            confidence: 0,
            meta: {
              source: 'result-analyzer',
              capability: 'resultAnalyzer',
            },
          });
        }
        return resultFromKernel('resultAnalyzer', result, {
          source: 'result-analyzer',
          capability: 'resultAnalyzer',
          input: request,
        }, {
          source: 'result-analyzer',
          capability: 'resultAnalyzer',
        });
      } catch (error) {
        return buildEnvelope({
          ok: false,
          tool: 'resultAnalyzer',
          status: 'unavailable',
          data: {
            source: 'result-analyzer',
            capability: 'resultAnalyzer',
            input: request,
          },
          error,
          confidence: 0,
          meta: {
            source: 'result-analyzer',
            capability: 'resultAnalyzer',
          },
        });
      }
    },
  });

  tools.push({
    name: 'replicationChecker',
    description: 'Check whether discovery results look reproducible.',
    inputSchema: {
      type: 'object',
      properties: {
        runs: { type: 'array' },
        observations: { type: 'array' },
        text: { type: 'string' },
        opts: { type: 'object' },
      },
    },
    async run(context = {}, input = {}) {
      const runner = resolveCapabilityRunner(kernel);
      if (!runner) {
        return buildEnvelope({
          ok: false,
          tool: 'replicationChecker',
          status: 'unavailable',
          data: {
            source: 'replication-checker',
            capability: 'replicationChecker',
            input: cloneValue(normalizeToolInput(input)),
          },
          error: { code: 'MISSING_METHOD', message: 'replicationChecker capability unavailable' },
          confidence: 0,
          meta: {
            source: 'replication-checker',
            capability: 'replicationChecker',
          },
        });
      }

      const payload = normalizeToolInput(input);
      const request = {
        runs: Array.isArray(payload.runs) ? payload.runs : (Array.isArray(context.runs) ? context.runs : []),
        observations: Array.isArray(payload.observations) ? payload.observations : (Array.isArray(context.observations) ? context.observations : []),
        text: payload.text || context.text || '',
        opts: payload.opts && typeof payload.opts === 'object' ? payload.opts : context.opts || {},
        input: cloneValue(payload),
      };

      try {
        const result = await runner.run('replicationChecker', request, request.opts);
        if (result && result.ok === false && isUnavailableCapabilityError(result.error)) {
          return buildEnvelope({
            ok: false,
            tool: 'replicationChecker',
            status: 'unavailable',
            data: {
              source: 'replication-checker',
              capability: 'replicationChecker',
              input: request,
            },
            error: { code: 'CAPABILITY_UNAVAILABLE', message: 'replicationChecker capability unavailable' },
            confidence: 0,
            meta: {
              source: 'replication-checker',
              capability: 'replicationChecker',
            },
          });
        }
        return resultFromKernel('replicationChecker', result, {
          source: 'replication-checker',
          capability: 'replicationChecker',
          input: request,
        }, {
          source: 'replication-checker',
          capability: 'replicationChecker',
        });
      } catch (error) {
        return buildEnvelope({
          ok: false,
          tool: 'replicationChecker',
          status: 'unavailable',
          data: {
            source: 'replication-checker',
            capability: 'replicationChecker',
            input: request,
          },
          error,
          confidence: 0,
          meta: {
            source: 'replication-checker',
            capability: 'replicationChecker',
          },
        });
      }
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
      const runner = resolveCapabilityRunner(kernel);
      if (!runner) {
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
        const result = await runner.run(capabilityName, capabilityInput, opts);
        return resultFromKernel('runCapability', result, {
          capability: capabilityName,
          input: capabilityInput,
        }, {
          source: runner.source,
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
            source: runner.source,
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
