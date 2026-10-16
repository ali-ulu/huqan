'use strict';

// The generic, policy-gated `runCapability` workflow tool (#2133). It is
// default-deny: without a policy that returns exactly `true`, nothing runs.

const { buildEnvelope, normalizeToolInput, resultFromKernel } = require('./workflow-tool-envelope');
const { resolveCapabilityRunner, getCapabilityMetadata } = require('./workflow-tool-capability-runner');

function isGenericCapabilityAllowed(policy, request) {
  if (typeof policy !== 'function') return false;
  try {
    return policy(request) === true;
  } catch (_error) {
    return false;
  }
}

function createRunCapabilityTool(kernel, options = {}) {
  return {
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

      const capability = getCapabilityMetadata(kernel, capabilityName);
      const policy = options.runCapabilityPolicy;
      const allowed = isGenericCapabilityAllowed(
        policy,
        { name: capabilityName, capability, input: capabilityInput, opts, context },
      );
      if (!allowed) {
        return buildEnvelope({
          ok: false,
          tool: 'runCapability',
          status: 'error',
          data: { capability: capabilityName },
          error: {
            code: 'CAPABILITY_NOT_ALLOWED',
            message: `Generic capability execution is not allowed: ${capabilityName}`,
          },
          confidence: 0,
          meta: { source: runner.source },
        });
      }

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
  };
}

module.exports = {
  createRunCapabilityTool,
};
