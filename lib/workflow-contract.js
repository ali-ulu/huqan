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

const OBJECT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: true });
const WORKSPACE_QUERY = Object.freeze({ name: 'workspaceId', in: 'query', required: true, schema: { type: 'string', minLength: 1, maxLength: 128 } });
const HTTP_SCHEMAS = Object.freeze({
  ask: { type: 'object', required: ['workspaceId', 'question'], properties: { workspaceId: { const: 'default' }, question: { type: 'string', minLength: 1, maxLength: 4000 } }, additionalProperties: false },
  verify: { type: 'object', required: ['workspaceId', 'claim'], properties: { workspaceId: { type: 'string', minLength: 1, maxLength: 128 }, claim: { type: 'string', minLength: 1, maxLength: 4000 } }, additionalProperties: false },
  advocate: { type: 'object', required: ['workspaceId', 'claim'], properties: { workspaceId: { const: 'default' }, claim: { type: 'string', minLength: 1, maxLength: 4000 } }, additionalProperties: false },
  'memory-search': { type: 'object', required: ['workspaceId', 'query'], properties: { workspaceId: { type: 'string', minLength: 1, maxLength: 128 }, query: { type: 'string', minLength: 1, maxLength: 300 } }, additionalProperties: false },
  'approval-decision': { type: 'object', required: ['decision'], properties: { decision: { enum: ['approved', 'rejected'] }, reason: { type: 'string' } }, additionalProperties: false },
  'ingest-execute': OBJECT_SCHEMA,
});

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
    security: Object.freeze({ scheme: 'bearerApiKey' }),
    requestSchema: mcpTool ? schemaFor(mcpTool, 'input') : null,
    responseSchema: mcpTool ? schemaFor(mcpTool, 'output') : null,
    ...definition,
    httpRequestSchema: definition.method === 'GET' ? null : (HTTP_SCHEMAS[definition.workflowId] || schemaFor(mcpTool, 'input') || OBJECT_SCHEMA),
    httpResponseSchema: OBJECT_SCHEMA,
    httpPolicy: Object.freeze({
      body: Object.freeze({ mediaType: 'application/json', maxBytes: definition.bodyMaxBytes ?? 8192 }),
      cache: 'no-store',
      cors: Object.freeze({ origins: 'loopback-only', methods: ['GET', 'POST', 'OPTIONS'], credentials: false, preflightMaxAgeSeconds: 600 }),
      rateLimit: Object.freeze({ enforced: true, scope: 'server-client-bucket', headers: false }),
      errors: Object.freeze({ operationEnvelope: 'WorkflowEnvelope', middlewareEnvelope: 'ApiError', codes: ['INVALID_INPUT', 'METHOD_NOT_ALLOWED', 'RATE_LIMITED', 'UNAUTHORIZED', 'WORKFLOW_FAILED'] }),
    }),
    availability: Object.freeze({ api: false, cli: false, mcp: Boolean(mcpTool), ui: false, ...availability }),
    mcpTool,
  });
}

const WORKFLOW_CAPABILITIES = Object.freeze([
  workflow({ workflowId: 'ask', route: '/api/v2/workflows/ask', method: 'POST', mcpTool: 'huqan.ask', compatibilityCommand: 'sor', availability: { api: true, cli: true, ui: true } }),
  workflow({ workflowId: 'verify', route: '/api/v2/workflows/verify', method: 'POST', mcpTool: 'huqan.verify', availability: { api: true, cli: true, ui: true } }),
  workflow({ workflowId: 'tool-policy', mcpTool: 'huqan.policy' }),
  workflow({ workflowId: 'advocate', route: '/api/v2/workflows/advocate', method: 'POST', availability: { api: true, ui: true } }),
  workflow({ workflowId: 'reason', mcpTool: 'huqan.reason', availability: { cli: true } }),
  workflow({ workflowId: 'compare', mcpTool: 'huqan.compare', availability: { cli: true } }),
  workflow({ workflowId: 'learn-review', route: '/api/v2/workflows/learn', method: 'POST', mcpTool: 'huqan.learn', mutation: true, approvalRequired: true, availability: { cli: true } }),
  workflow({ workflowId: 'approvals', route: '/api/v2/approvals', method: 'GET', mcpTool: 'huqan.approvals', bodyMaxBytes: 4096, availability: { api: true, cli: true } }),
  workflow({ workflowId: 'approval-detail', route: '/api/v2/approvals/{id}', method: 'GET', bodyMaxBytes: 4096, availability: { api: true } }),
  workflow({ workflowId: 'approval-decision', route: '/api/v2/approvals/{id}/decision', method: 'POST', mcpTool: 'huqan.approve', bodyMaxBytes: 4096, mutation: true, approvalRequired: true, availability: { api: true, cli: true } }),
  workflow({ workflowId: 'memory-search', route: '/api/v2/workflows/search', method: 'POST', availability: { api: true, ui: true } }),
  workflow({ workflowId: 'ingest-preview', route: '/api/v2/ingest/preview', method: 'POST', availability: { api: true } }),
  workflow({ workflowId: 'ingest-execute', route: '/api/ingest', method: 'POST', bodyMaxBytes: 1048576, mutation: true, approvalRequired: true, workspaceRequired: false, availability: { api: true, cli: true } }),
  workflow({ workflowId: 'agent-plan', route: '/api/v2/agent/plan', method: 'POST', mcpTool: 'huqan.plan', availability: { cli: true } }),
  workflow({ workflowId: 'agent-run', route: '/api/v2/agent/runs', method: 'POST', mcpTool: 'huqan.agent', availability: { cli: true } }),
  workflow({ workflowId: 'trust-receipt', route: '/api/trust-receipt', method: 'GET', availability: { api: true, ui: true } }),
  workflow({ workflowId: 'trust-receipt-detail', route: '/api/v2/trust-receipts/{id}', method: 'GET', availability: { api: true } }),
  workflow({ workflowId: 'quickstart', workspaceRequired: false, availability: { cli: true } }),
  workflow({ workflowId: 'system-status', mutation: false, availability: { cli: true } }),
  workflow({ workflowId: 'dream', mcpTool: 'huqan.dream', mutation: false, availability: { cli: true } }),
  workflow({ workflowId: 'backup', mutation: true, availability: { cli: true } }),
  workflow({ workflowId: 'restore', mutation: true, availability: { cli: true } }),
  workflow({ workflowId: 'persist', mutation: true, availability: { cli: true } }),
  workflow({ workflowId: 'recommendation', mutation: false, availability: { cli: true } }),
]);

const CLI_COMMAND_CAPABILITIES = Object.freeze([
  ['quickstart', 'quickstart', 'quickstart', 'your first Trust Receipt (one command, no API key needed)', ['demo', 'başla', 'basla']],
  ['öğret', 'learn-review', 'kedi balik yer', 'I learn a fact', ['learn', 'teach']],
  ['sor', 'ask', 'kedi nedir', 'I answer the question', ['ask']],
  ['neden', 'reason', 'neden tavuk', 'cause analysis', ['why']],
  ['karşılaştır', 'compare', 'tavuk mu yumurta mi', 'comparison', ['compare']],
  ['verify', 'verify', 'verify: kedi bitkidir', 'guarded verification', ['dogrula']],
  ['durum', 'system-status', 'durum', 'system status', []],
  ['rüya', 'dream', 'ruya', 'I generate hypotheses', []],
  ['plan', 'agent-plan', 'plan: hedef', 'I produce an agent plan', []],
  ['ajan', 'agent-run', 'ajan: hedef', 'I run the agent', []],
  ['company-ingest', 'ingest-execute', 'ogren --kaynak <tur> ...', 'ingest a supported source', []],
  ['backup', 'backup', 'backup', 'I back up the current state', ['yedek', 'yedekle']],
  ['restore', 'restore', 'restore[: yol]', 'I restore the latest or a chosen backup', ['geri yükle', 'geri yukle']],
  ['kaydet', 'persist', 'kaydet', 'I save memory', []],
  ['onaylar', 'approvals', 'onaylar', 'I list pending learn approvals', ['approvals']],
  ['onayla', 'approval-decision', 'onayla <id> [karar]', 'I resolve a pending learn as approved/rejected', ['approve']],
  ['llm-sor', 'recommendation', 'llm-sor: soru', 'I prepare an LLM recommendation', []],
  ['yükle', 'learn-review', 'yükle: dosya.txt', 'I learn from a file', ['upload']],
].map(([command, workflowId, usage, description, aliases]) => Object.freeze({
  command, workflowId, usage, description, aliases: Object.freeze(aliases),
})));

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
    cliCommands: CLI_COMMAND_CAPABILITIES.map(item => ({ ...item, aliases: [...item.aliases] })),
    workflows: WORKFLOW_CAPABILITIES.map(item => ({
      ...item,
      availability: { ...item.availability },
    })),
  });
}

function workflowForMcpTool(toolName) {
  return WORKFLOW_CAPABILITIES.find(item => item.mcpTool === toolName) || null;
}

function mcpWorkflowMetadata(toolName) {
  const item = workflowForMcpTool(toolName);
  if (!item) return null;
  return structuredClone({
    workflowId: item.workflowId,
    version: item.version,
    mutation: item.mutation,
    authRequired: item.authRequired,
    workspaceRequired: item.workspaceRequired,
    approvalRequired: item.approvalRequired,
    counterparts: {
      api: item.availability.api ? { method: item.method, route: item.route } : null,
      cli: item.availability.cli ? { command: item.compatibilityCommand || item.workflowId } : null,
      ui: item.availability.ui ? { workflowId: item.workflowId } : null,
    },
  });
}

function workflowOpenApiDocument() {
  const paths = {};
  for (const item of WORKFLOW_CAPABILITIES.filter(entry => entry.availability.api)) {
    const method = item.method.toLowerCase();
    const parameters = [];
    if (item.route.includes('{id}')) parameters.push({ name: 'id', in: 'path', required: true, schema: { type: 'string', minLength: 1 } });
    if (item.workspaceRequired && item.method === 'GET') parameters.push(WORKSPACE_QUERY);
    const operation = {
      operationId: item.workflowId,
      tags: ['workflows'],
      security: item.authRequired ? [{ bearerApiKey: [] }] : [],
      parameters,
      responses: {
        200: { description: 'Workflow response', content: { 'application/json': { schema: { $ref: '#/components/schemas/WorkflowEnvelope' } } } },
        400: { $ref: '#/components/responses/WorkflowError' },
        401: { $ref: '#/components/responses/WorkflowError' },
        405: { $ref: '#/components/responses/WorkflowError' },
        429: { $ref: '#/components/responses/WorkflowError' },
      },
      'x-huqan-workflow': { version: item.version, mutation: item.mutation, approvalRequired: item.approvalRequired, cache: item.httpPolicy.cache, cors: item.httpPolicy.cors, rateLimit: item.httpPolicy.rateLimit, errors: item.httpPolicy.errors },
    };
    if (item.method !== 'GET') operation.requestBody = {
      required: true,
      content: { 'application/json': { schema: item.httpRequestSchema } },
      'x-maxBytes': item.httpPolicy.body.maxBytes,
    };
    paths[item.route] ||= {};
    paths[item.route][method] = operation;
  }
  return structuredClone({
    openapi: '3.1.0',
    info: { title: 'HUQAN canonical workflow HTTP API', version: WORKFLOW_CONTRACT_VERSION },
    paths,
    components: {
      securitySchemes: { bearerApiKey: { type: 'http', scheme: 'bearer', description: 'HUQAN_API_KEY' } },
      schemas: {
        WorkflowEnvelope: { type: 'object', required: ['ok', 'status', 'data', 'error', 'evidence', 'confidence', 'traceId', 'receiptId'], properties: { ok: { type: 'boolean' }, status: { enum: [...WORKFLOW_STATUSES] }, data: {}, error: { anyOf: [{ type: 'null' }, { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' } } }] }, evidence: { type: 'array', items: {} }, confidence: { type: ['number', 'null'] }, traceId: { type: 'string' }, receiptId: { type: ['string', 'null'] } } },
        ApiError: { type: 'object', required: ['ok', 'error'], properties: { ok: { const: false }, error: { type: 'object', required: ['code', 'message'], properties: { code: { type: 'string' }, message: { type: 'string' }, details: { type: 'object' } } } } },
      },
      responses: { WorkflowError: { description: 'Fail-closed operation or middleware error', content: { 'application/json': { schema: { oneOf: [{ $ref: '#/components/schemas/WorkflowEnvelope' }, { $ref: '#/components/schemas/ApiError' }] } } } } },
    },
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
  CLI_COMMAND_CAPABILITIES,
  COMPATIBILITY_COMMANDS,
  publicWorkflowManifest,
  workflowForMcpTool,
  mcpWorkflowMetadata,
  workflowOpenApiDocument,
  compatibilityHelpText,
};
