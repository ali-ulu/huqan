const { assertBootEnvironment, reportBootConflict } = require('./lib/environment-compat');

// The HUQAN MCP server entrypoint: it builds the runtime a server needs and
// wires the pieces together. The tool list, operator authorisation, dispatch,
// gate refusals, handlers, JSON-RPC methods and the stdio transport each live
// in lib/mcp/ (#2142).

const path = require('path');
const { createProcessFailureHandlers, failureCodeFor } = require('./lib/http/process-failure-handlers');
const { writeStructuredLog } = require('./lib/http/structured-log');
const {
  capabilityBinding,
  createMcpOperatorCapability,
  verifyMcpOperatorCapability,
} = require('./lib/mcp-operator-capability');
const { createDurableCapabilityNonceStore, resolveCapabilityNonceDirectory } = require('./lib/mcp-capability-nonce-store');
const { buildKernelOptsFromEnv } = require('./lib/kernel-factory');
const { createAgent, resolveExperienceJournal } = require('./agentRuntime');
const { CANONICAL_MCP_TOOL_NAMES, LEGACY_MCP_TOOL_NAMES } = require('./lib/mcp-tool-names');
const { VERIFY_STATUS } = require('./lib/mcp-envelope-schema');
const { sanitizeToolArgsForStorage } = require('./lib/mcp-input-sanitizers');
const { createKernelFromEnv, createApprovalStoreFromKernel } = require('./lib/mcp-approval-store');
const { recordInternalError } = require('./lib/mcp-envelope-format');
const { createMcpServerCloser } = require('./lib/mcp/server-lifecycle');
const {
  TOOL_SCHEMAS,
  WORKFLOW_TOOL_SCHEMAS,
  OPERATOR_TOOL_SCHEMAS,
  MODEL_VISIBLE_TOOL_SCHEMAS,
} = require('./lib/mcp/tool-surface');
const { operatorCapabilityBinding } = require('./lib/mcp/operator-authorization');
const { createTransientAgentRunner } = require('./lib/mcp/transient-agent');
const { createMcpToolDispatch } = require('./lib/mcp/tool-dispatch');
const { PROTOCOL_VERSION, SERVER_NAME, createJsonRpcHandler } = require('./lib/mcp/json-rpc-handler');
const { MCP_MAX_FRAME_BYTES, MCP_MAX_JSON_DEPTH, MCP_MAX_JSON_VALUES, serveStdio } = require('./lib/mcp/stdio-transport');

const MCP_OPERATOR_TOKEN_ENV = 'HUQAN_MCP_OPERATOR_TOKEN';

const withTransientAgent = createTransientAgentRunner(createAgent);
const { callTool, executeReadOnlyDryRun } = createMcpToolDispatch({ withTransientAgent });

function createServer(kernelOrOptions = {}) {
  const options = kernelOrOptions && typeof kernelOrOptions === 'object' && typeof kernelOrOptions.learn === 'function'
    ? { kernel: kernelOrOptions }
    : (kernelOrOptions || {});
  const envKernelOpts = options.kernel ? {} : buildKernelOptsFromEnv();
  const kernel = options.kernel || createKernelFromEnv();
  const approvalStore = createApprovalStoreFromKernel(kernel, { ...envKernelOpts, ...options });
  resolveExperienceJournal({
    kernel,
    ...(Object.hasOwn(options, 'experienceJournal') ? { experienceJournal: options.experienceJournal } : {}),
  }, approvalStore);
  const operatorToken = options.operatorToken || process.env[MCP_OPERATOR_TOKEN_ENV] || '';
  // Consumed capability nonces are durable by default (#1674): a capability is
  // valid for up to five minutes, so a restart inside that window must not
  // hand a spent token a second life. A caller may pass its own store (the
  // in-process tests pass a Map); everything else gets the on-disk store,
  // which is atomic across concurrent workers and fails closed when the
  // directory cannot be written.
  const operatorCapabilityNonces = options.operatorCapabilityNonces
    || createDurableCapabilityNonceStore({ directory: resolveCapabilityNonceDirectory(options, envKernelOpts) });
  let companyRuntimeReady = false;
  function ensureCompanyRuntime() {
    if (typeof kernel.hasCapability === 'function' && !kernel.hasCapability('companyMode')) {
      kernel.enableCapability('companyMode');
    }
    if (typeof kernel.hasCapability === 'function' && !kernel.hasCapability('pluginCapabilities')) {
      kernel.enableCapability('pluginCapabilities');
    }
    if (!companyRuntimeReady && kernel.plugins && typeof kernel.plugins.load === 'function') {
      kernel.plugins.load(path.join(__dirname, 'plugins'));
      companyRuntimeReady = true;
    }
  }
  const close = createMcpServerCloser({ kernel, approvalStore, operatorCapabilityNonces,
    ownsKernel: !options.kernel, ownsApprovalStore: !Object.hasOwn(options, 'approvalStore'),
    ownsOperatorCapabilityNonces: !Object.hasOwn(options, 'operatorCapabilityNonces') });
  const handleRequest = createJsonRpcHandler({
    // A cancelled tools/call leaves its receipt in the kernel's mutation
    // journal: idempotent per operation id, readable by prefix (#3484).
    recordCancellation: (operationId, receipt) => {
      if (!kernel.graph || typeof kernel.graph.runMutationOnce !== 'function') {
        throw new Error('kernel graph has no mutation journal');
      }
      kernel.graph.runMutationOnce(operationId, () => receipt);
    },
    callTool: params => callTool(kernel, params, {
      approvalStore,
      // Host-owned context; never populated from tools/call params.
      gateMetadata: options.gateMetadata,
      operatorSecret: operatorToken,
      operatorCapabilityNonces,
      trustEvidenceLedger: options.trustEvidenceLedger || null,
      ensureRuntime: ensureCompanyRuntime,
      humanOversightApprovalRuntime: options.humanOversightApprovalRuntime || null,
      ...(Object.hasOwn(options, 'humanOversightRequesterContext')
        ? { humanOversightRequesterContext: options.humanOversightRequesterContext }
        : {}),
      ...(Object.hasOwn(options, 'humanOversightApproverContext')
        ? { humanOversightApproverContext: options.humanOversightApproverContext }
        : {}),
      ...(Object.hasOwn(options, 'humanOversightContextResolver')
        ? { humanOversightContextResolver: options.humanOversightContextResolver }
        : {}),
      agentIdentityRuntime: Object.hasOwn(options, 'agentIdentityRuntime')
        ? options.agentIdentityRuntime
        : null,
    }),
  });
  return {
    kernel,
    approvalStore,
    operatorToken,
    operatorCapabilityNonces,
    close,
    handleRequest,
  };
}

function runStdio() {
  assertBootEnvironment();
  serveStdio(createServer());
}

const mcpProcessFailureHandlers = createProcessFailureHandlers({
  // console.error writes to stderr, so the stdio JSON-RPC frames on stdout stay intact.
  logError: (kind, cause) => writeStructuredLog(console, 'error', kind === 'uncaughtException' ? 'process.uncaught_exception' : 'process.unhandled_rejection', null, {
    runtime: 'mcp',
    errorCode: failureCodeFor(kind, cause),
  }),
});

if (require.main === module) {
  mcpProcessFailureHandlers.bind();
  try { runStdio(); } catch (error) { if (!reportBootConflict('mcp', error)) throw error; process.exitCode = 1; }
}

module.exports = {
  PROTOCOL_VERSION,
  MCP_MAX_FRAME_BYTES,
  MCP_MAX_JSON_DEPTH,
  MCP_MAX_JSON_VALUES,
  SERVER_NAME,
  TOOL_SCHEMAS,
  WORKFLOW_TOOL_SCHEMAS,
  OPERATOR_TOOL_SCHEMAS,
  MODEL_VISIBLE_TOOL_SCHEMAS,
  MCP_OPERATOR_TOKEN_ENV,
  CANONICAL_MCP_TOOL_NAMES,
  LEGACY_MCP_TOOL_NAMES,
  VERIFY_STATUS,
  buildKernelOptsFromEnv,
  createDurableCapabilityNonceStore,
  resolveCapabilityNonceDirectory,
  createKernelFromEnv,
  createApprovalStoreFromKernel,
  callTool,
  createServer,
  runStdio,
  recordInternalError,
  sanitizeToolArgsForStorage,
  executeReadOnlyDryRun,
  withTransientAgent,
  capabilityBinding,
  createMcpOperatorCapability,
  verifyMcpOperatorCapability,
  operatorCapabilityBinding,
};
