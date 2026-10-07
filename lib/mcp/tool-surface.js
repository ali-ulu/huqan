'use strict';

// The MCP tool list as published: each tool's workflow contract stamped onto
// its schemas, and the split between what a model may discover and what only
// an operator may call (#2142).

const { TOOL_SCHEMAS } = require('../mcp-tool-catalog');
const { mcpWorkflowMetadata } = require('../workflow-contract');
const { CANONICAL_MCP_TOOL_PREFIX } = require('../mcp-tool-names');
const { namesConform } = require('../mcp-call-binding');

/** Tools that need a scoped operator capability and are never listed to a model. */
const OPERATOR_TOOL_NAMES = Object.freeze(['huqan.approve', 'huqan.approvals', 'huqan.approval_detail', 'huqan.agent_resume', 'huqan.emergency_stop']);

function publishMcpWorkflowContract(tool) {
  const workflow = mcpWorkflowMetadata(tool.name);
  if (!workflow) return tool;
  return {
    ...tool,
    inputSchema: { $id: `huqan.workflow.${workflow.workflowId}.input.${workflow.version}`, ...tool.inputSchema },
    outputSchema: { $id: `huqan.workflow.${workflow.workflowId}.output.${workflow.version}`, ...tool.outputSchema },
    metadata: { workflow },
  };
}

const WORKFLOW_TOOL_SCHEMAS = Object.freeze(TOOL_SCHEMAS.map(publishMcpWorkflowContract));
const OPERATOR_TOOL_SCHEMAS = Object.freeze(
  WORKFLOW_TOOL_SCHEMAS.filter(({ name }) => OPERATOR_TOOL_NAMES.includes(name)),
);
const MODEL_VISIBLE_TOOL_SCHEMAS = Object.freeze(
  WORKFLOW_TOOL_SCHEMAS.filter(({ name }) => !OPERATOR_TOOL_NAMES.includes(name)),
);

// Publication is fail-closed too: a catalog name outside SEP-986 or outside
// the server's own namespace stops the server from loading (#3488).
if (!namesConform(WORKFLOW_TOOL_SCHEMAS.map(({ name }) => name), [CANONICAL_MCP_TOOL_PREFIX])) {
  throw new Error('MCP tool catalog publishes a name outside SEP-986 or the huqan. namespace');
}

module.exports = {
  TOOL_SCHEMAS,
  OPERATOR_TOOL_NAMES,
  WORKFLOW_TOOL_SCHEMAS,
  OPERATOR_TOOL_SCHEMAS,
  MODEL_VISIBLE_TOOL_SCHEMAS,
};
