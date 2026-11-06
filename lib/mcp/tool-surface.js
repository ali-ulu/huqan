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

// The gate reads these keys from ANY tool's arguments as the cross-tool action
// hint (lib/mcp-gate-adapter-inputs.js deriveMcpAction), so they are part of the
// calling convention rather than a tool's own parameter set. A tool whose schema
// declares one of them (emergency_stop.action, agent_resume.mode,
// experience_learn.kind) keeps its own, stricter declaration.
const GATE_ACTION_HINT_KEYS = Object.freeze(['action', 'operation', 'mode', 'intent', 'kind', 'type']);

const TOOL_INPUT_SCHEMAS = new Map(TOOL_SCHEMAS.map(tool => [tool.name, tool.inputSchema]));

function isArgsRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

// The catalog marks every inputSchema `additionalProperties: false` and
// `tools/list` serves it, but dispatch passed arguments through without checking
// that closed set, so a tool advertised a fixed set of parameters and then
// silently accepted any other one (#4525). Handlers still own the required
// fields, bounds and enums; this covers the one thing no handler can: the
// schema's own declared names.
function unknownArgumentError(name, args) {
  const schema = TOOL_INPUT_SCHEMAS.get(name);
  if (!isArgsRecord(args) || !isArgsRecord(schema) || schema.additionalProperties !== false) return null;
  const properties = isArgsRecord(schema.properties) ? schema.properties : {};
  const unknown = Object.keys(args).find(key =>
    !Object.hasOwn(properties, key) && !GATE_ACTION_HINT_KEYS.includes(key));
  return unknown ? `arguments.${unknown} is not allowed by the tool's input schema` : null;
}

function publishMcpWorkflowContract(tool) {
  // The gate reads the cross-tool action hints from any tool's arguments
  // (lib/mcp-gate-adapter-inputs.js deriveMcpAction), so a published schema that
  // omitted them would advertise a narrower contract than dispatch enforces
  // (#4525). A tool that already declares one keeps its own, stricter entry.
  const inputSchema = {
    ...tool.inputSchema,
    properties: {
      ...Object.fromEntries(GATE_ACTION_HINT_KEYS.map(key => [key, {}])),
      ...tool.inputSchema.properties,
    },
  };
  const workflow = mcpWorkflowMetadata(tool.name);
  if (!workflow) return { ...tool, inputSchema };
  return {
    ...tool,
    inputSchema: { $id: `huqan.workflow.${workflow.workflowId}.input.${workflow.version}`, ...inputSchema },
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
  unknownArgumentError,
};
