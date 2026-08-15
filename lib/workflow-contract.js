'use strict';

const { TOOL_SCHEMAS } = require('./mcp-tool-catalog');

const WORKFLOW_CONTRACT_VERSION = '2.0.0';
const WORKFLOW_STATUSES = Object.freeze([
  'completed',
  'queued',
  'review_required',
  'blocked',
  'paused',
  'partial',
  'failed',
  'capability_not_available',
]);

const toolSchemas = new Map(TOOL_SCHEMAS.map(tool => [tool.name, tool]));

function schemaFor(toolName, side) {
  const tool = toolSchemas.get(toolName);
  if (!tool) return null;
  return side === 'input' ? tool.inputSchema : tool.outputSchema;
}

function workflow(definition) {
  const mcpTool = definition.mcpTool || null;
  const availability = definition.availability || {};
  return Object.freeze({
    version: WORKFLOW_CONTRACT_VERSION,
    authRequired: true,
    workspaceRequired: true,
    mutation: false,
    approvalRequired: false,
    requestSchema: mcpTool ? schemaFor(mcpTool, 'input') : null,
    responseSchema: mcpTool ? schemaFor(mcpTool, 'output') : null,
    ...definition,
    availability: Object.freeze({ api: false, cli: false, mcp: Boolean(mcpTool), ui: false, ...availability }),
    mcpTool,
  });
}

const WORKFLOW_CAPABILITIES = Object.freeze([
  workflow({ workflowId: 'ask', route: '/api/v2/workflows/ask', method: 'POST', mcpTool: 'huqan.ask', compatibilityCommand: 'sor', availability: { api: true, cli: true, ui: true } }),
  workflow({ workflowId: 'verify', route: '/api/v2/workflows/verify', method: 'POST', mcpTool: 'huqan.verify', availability: { api: true, cli: true, ui: true } }),
  workflow({ workflowId: 'advocate', route: '/api/v2/workflows/advocate', method: 'POST', availability: { api: true, ui: true } }),
  workflow({ workflowId: 'learn-review', route: '/api/v2/workflows/learn', method: 'POST', mcpTool: 'huqan.learn', mutation: true, approvalRequired: true, availability: { cli: true } }),
  workflow({ workflowId: 'approvals', route: '/api/v2/approvals', method: 'GET', mcpTool: 'huqan.approvals' }),
  workflow({ workflowId: 'approval-decision', route: '/api/v2/approvals/{id}/decision', method: 'POST', mcpTool: 'huqan.approve', mutation: true, approvalRequired: true }),
  workflow({ workflowId: 'memory-search', route: '/api/v2/workflows/search', method: 'POST', availability: { api: true, ui: true } }),
  workflow({ workflowId: 'ingest-preview', route: '/api/v2/ingest/preview', method: 'POST' }),
  workflow({ workflowId: 'ingest-execute', route: '/api/ingest', method: 'POST', mutation: true, approvalRequired: true, workspaceRequired: false, availability: { api: true } }),
  workflow({ workflowId: 'agent-plan', route: '/api/v2/agent/plan', method: 'POST', mcpTool: 'huqan.plan', availability: { cli: true } }),
  workflow({ workflowId: 'agent-run', route: '/api/v2/agent/runs', method: 'POST', mcpTool: 'huqan.agent', availability: { cli: true } }),
  workflow({ workflowId: 'trust-receipt', route: '/api/trust-receipt', method: 'GET', availability: { api: true, ui: true } }),
]);

const COMPATIBILITY_COMMANDS = Object.freeze([
  Object.freeze({ command: 'selam', authRequired: false, description: 'sabit selamlama' }),
  Object.freeze({ command: 'yardim', authRequired: false, description: 'desteklenen komutlari gosterir' }),
  Object.freeze({ command: 'anlamadim', authRequired: false, description: 'sabit yonlendirme' }),
  Object.freeze({ command: 'sor', authRequired: true, workflowId: 'ask', description: 'workspace bilgisinden cevaplar' }),
  Object.freeze({ command: 'durum', authRequired: true, description: 'workspace durumunu gosterir' }),
]);

function publicWorkflowManifest() {
  return structuredClone({
    contractVersion: WORKFLOW_CONTRACT_VERSION,
    statuses: [...WORKFLOW_STATUSES],
    compatibility: COMPATIBILITY_COMMANDS.map(item => ({ ...item })),
    workflows: WORKFLOW_CAPABILITIES.map(item => ({
      ...item,
      availability: { ...item.availability },
    })),
  });
}

function compatibilityHelpText() {
  return [
    'HUQAN HTTP uyumluluk komutlari:',
    ...COMPATIBILITY_COMMANDS.map(item => `  "${item.command}" -> ${item.description}${item.authRequired ? ' (API key gerekir)' : ''}`),
    'Diger workflow\'lar icin /api/v2/workflows capability manifestine bakin.',
  ].join('\n');
}

module.exports = {
  WORKFLOW_CONTRACT_VERSION,
  WORKFLOW_STATUSES,
  WORKFLOW_CAPABILITIES,
  COMPATIBILITY_COMMANDS,
  publicWorkflowManifest,
  compatibilityHelpText,
};
