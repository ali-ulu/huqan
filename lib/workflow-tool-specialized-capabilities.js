'use strict';

// Workflow tools that each front one named capability: companyBrain and the
// four discovery-loop capabilities (#2133).
//
// They were five hand-copied bodies that differed only in name, domain source,
// schema and how the request is shaped. Those differences are the specs below;
// the fail-closed handling they shared is `createSpecializedCapabilityTool`.

const { cloneValue, normalizeToolInput, buildEnvelope, resultFromKernel } = require('./workflow-tool-envelope');
const { resolveCapabilityRunner, isUnavailableCapabilityError } = require('./workflow-tool-capability-runner');

const pickOpts = (payload, context) => (payload.opts && typeof payload.opts === 'object' ? payload.opts : context.opts || {});
const pickArray = (payload, context, key) => (Array.isArray(payload[key]) ? payload[key] : (Array.isArray(context[key]) ? context[key] : []));
const pickText = (payload, context, key) => payload[key] || context[key] || '';

// A discovery-loop request carries its own opts and hands the same object to the runner.
function discoveryRequest(fields) {
  return (payload, context) => {
    const request = { ...fields(payload, context), text: pickText(payload, context, 'text'), opts: pickOpts(payload, context), input: cloneValue(payload) };
    return { request, opts: request.opts };
  };
}

const SPECIALIZED_CAPABILITIES = [
  {
    name: 'companyBrain',
    source: 'company-brain',
    description: 'Query or ingest company memory through the company-brain capability.',
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
    // Unlike the discovery loop, companyBrain keeps opts out of the request.
    buildRequest(payload, context) {
      const request = {
        action: String(payload.action || context.action || 'query').toLowerCase(),
        question: pickText(payload, context, 'question'),
        text: pickText(payload, context, 'text'),
        sourceType: String(payload.sourceType || context.sourceType || '').toLowerCase(),
        title: pickText(payload, context, 'title'),
        rationale: pickText(payload, context, 'rationale'),
        decidedBy: pickText(payload, context, 'decidedBy'),
        date: pickText(payload, context, 'date'),
        links: pickArray(payload, context, 'links'),
        alternatives: pickArray(payload, context, 'alternatives'),
        sessionId: pickText(payload, context, 'sessionId'),
        input: cloneValue(payload),
      };
      return { request, opts: pickOpts(payload, context) };
    },
  },
  {
    name: 'discoveryEngine',
    source: 'discovery-engine',
    description: 'Run the discovery engine skeleton through the kernel.',
    properties: { goal: { type: 'string' }, hypothesis: { type: 'string' }, text: { type: 'string' }, opts: { type: 'object' } },
    buildRequest: discoveryRequest((payload, context) => ({ goal: pickText(payload, context, 'goal'), hypothesis: pickText(payload, context, 'hypothesis') })),
  },
  {
    name: 'experimentPlanner',
    source: 'experiment-planner',
    description: 'Create an experiment plan for a discovery hypothesis.',
    properties: { goal: { type: 'string' }, hypothesis: { type: 'string' }, text: { type: 'string' }, opts: { type: 'object' } },
    buildRequest: discoveryRequest((payload, context) => ({ goal: pickText(payload, context, 'goal'), hypothesis: pickText(payload, context, 'hypothesis') })),
  },
  {
    name: 'resultAnalyzer',
    source: 'result-analyzer',
    description: 'Analyze discovery results into a minimal evidence summary.',
    properties: { result: { type: 'string' }, observation: { type: 'string' }, text: { type: 'string' }, opts: { type: 'object' } },
    buildRequest: discoveryRequest((payload, context) => ({ result: pickText(payload, context, 'result'), observation: pickText(payload, context, 'observation') })),
  },
  {
    name: 'replicationChecker',
    source: 'replication-checker',
    description: 'Check whether discovery results look reproducible.',
    properties: { runs: { type: 'array' }, observations: { type: 'array' }, text: { type: 'string' }, opts: { type: 'object' } },
    buildRequest: discoveryRequest((payload, context) => ({ runs: pickArray(payload, context, 'runs'), observations: pickArray(payload, context, 'observations') })),
  },
];

function createSpecializedCapabilityTool(kernel, { name, source, description, properties, buildRequest }) {
  const failure = (input, error, runnerSource) => buildEnvelope({
    ok: false,
    tool: name,
    status: 'unavailable',
    data: { source, capability: name, input },
    error,
    confidence: 0,
    meta: runnerSource === undefined
      ? { source, capability: name }
      : { source, runnerSource, capability: name },
  });

  return {
    name,
    description,
    inputSchema: { type: 'object', properties },
    async run(context = {}, input = {}) {
      const runner = resolveCapabilityRunner(kernel);
      if (!runner) {
        return failure(cloneValue(normalizeToolInput(input)), { code: 'MISSING_METHOD', message: `${name} capability unavailable` });
      }

      const { request, opts } = buildRequest(normalizeToolInput(input), context);

      try {
        const result = await runner.run(name, request, opts);
        if (result && result.ok === false && isUnavailableCapabilityError(result.error)) {
          return failure(request, { code: 'CAPABILITY_UNAVAILABLE', message: `${name} capability unavailable` }, runner.source);
        }
        return resultFromKernel(name, result, {
          source,
          capability: name,
          input: request,
        }, {
          source,
          runnerSource: runner.source,
          capability: name,
        });
      } catch (error) {
        return failure(request, error, runner.source);
      }
    },
  };
}

function createSpecializedCapabilityTools(kernel) {
  return SPECIALIZED_CAPABILITIES.map(spec => createSpecializedCapabilityTool(kernel, spec));
}

module.exports = {
  createSpecializedCapabilityTools,
};
