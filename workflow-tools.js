const { registerReceiverOwnedTool } = require('./workflow-agent');
const { normalizeToolInput, buildEnvelope, resultFromKernel } = require('./lib/workflow-tool-envelope');
const { resolveCapabilityRunner } = require('./lib/workflow-tool-capability-runner');
const { createVerifyClaimTool, createFindContradictionsTool, createRankEvidenceTool, createGraphStatsTool } = require('./lib/workflow-tool-kernel-queries');
const { createRepoMemoryTool } = require('./lib/workflow-tool-repo-memory');
const { createSpecializedCapabilityTools } = require('./lib/workflow-tool-specialized-capabilities');
const { createRunCapabilityTool } = require('./lib/workflow-tool-run-capability');

// The order is the public tool list; callers and the MCP surface enumerate it.
function createWorkflowTools(kernel, options = {}) {
  const tools = [];

  tools.push(createVerifyClaimTool(kernel));
  tools.push(createFindContradictionsTool(kernel));
  tools.push(createRankEvidenceTool());
  tools.push(createRepoMemoryTool({ kernel, buildEnvelope, normalizeToolInput, resolveCapabilityRunner, resultFromKernel }));
  tools.push(...createSpecializedCapabilityTools(kernel));
  tools.push(createRunCapabilityTool(kernel, options));
  tools.push(createGraphStatsTool(kernel));

  return tools;
}

function registerDefaultWorkflowTools(registry, kernel, options = {}) {
  if (!registry || typeof registry.registerTool !== 'function') {
    throw new Error('Registry with registerTool() is required.');
  }
  const tools = createWorkflowTools(kernel, options);
  for (const tool of tools) {
    registerReceiverOwnedTool(registry, tool);
  }
  return tools;
}

module.exports = {
  createWorkflowTools,
  registerDefaultWorkflowTools,
};
