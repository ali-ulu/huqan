const {
  readCompatibleEnvironmentVariable,
  validateEnvironmentCompatibility,
} = require('./lib/environment-compat');
validateEnvironmentCompatibility();

const fs = require('fs');
const readline = require('readline');
const crypto = require('crypto');
const { buildKernelOptsFromEnv } = require('./lib/kernel-factory');
const { createAgent } = require('./agentRuntime');
const { evaluateMcpGate, MCP_GATE_DECISIONS } = require('./lib/mcp-gate-adapter');
const { emitGateTelemetry } = require('./lib/gate-telemetry');
const { applyHumanApprovalToggle } = require('./lib/human-approval-toggle');
const { scrubSecrets } = require('./lib/secret-scrub-gate');
const { withMcpToolVerdictSurface } = require('./lib/mcp/response-builders');
const {
  CANONICAL_MCP_TOOL_NAMES,
  LEGACY_MCP_TOOL_NAMES,
  canonicalMcpToolName,
  isLegacyMcpToolName,
  mcpToolDeprecationNotice,
  withMcpToolDeprecationSurface,
} = require('./lib/mcp-tool-names');
const { parseJsonObject } = require('./lib/json-object');
const {
  formatApprovalRecord,
  listPersistentApprovals,
  countPersistentApprovals,
  countUnresolvedApprovals,
} = require('./lib/mcp-approval-views');
const pkg = require('./package.json');
const { VERIFY_STATUS } = require('./lib/mcp-envelope-schema');
const { VERIFY_ENVELOPE_OUTPUT_SCHEMA } = require('./lib/mcp-tool-data-schemas');
const { TOOL_SCHEMAS } = require('./lib/mcp-tool-catalog');
const MODEL_VISIBLE_TOOL_SCHEMAS = Object.freeze(
  TOOL_SCHEMAS.filter(({ name }) => name !== 'huqan.approve' && name !== 'huqan.approvals'),
);

const PROTOCOL_VERSION = '2025-06-18';
// RFC-001 decision 1: HUQAN is the canonical product identity. This is the
// name a Claude Desktop / Cursor user sees for the server itself.
const SERVER_NAME = 'huqan';
const SERVER_VERSION = pkg.version;
const MCP_OPERATOR_TOKEN_ENV = 'HUQAN_MCP_OPERATOR_TOKEN';

const {
  MCP_MAX_TEXT,
  MCP_MAX_GOAL,
  MCP_MAX_SHORT,
  sanitizeMcpString,
  boundedMcpInteger,
  sanitizeMcpApprovalDecision,
  sanitizeToolArgsForStorage,
} = require('./lib/mcp-input-sanitizers');
const {
  createKernelFromEnv,
  createApprovalStoreFromKernel,
  saveMcpApproval,
} = require('./lib/mcp-approval-store');
const {
  toToolResult,
  recordInternalError,
} = require('./lib/mcp-envelope-format');

function isMcpOperatorAuthorized(configuredToken, presentedToken) {
  if (typeof configuredToken !== 'string' || typeof presentedToken !== 'string' || !configuredToken || !presentedToken) return false;
  const configured = Buffer.from(configuredToken);
  const presented = Buffer.from(presentedToken);
  return configured.length === presented.length && crypto.timingSafeEqual(configured, presented);
}

function createServer(kernelOrOptions = {}) {
  const options = kernelOrOptions && typeof kernelOrOptions === 'object' && typeof kernelOrOptions.learn === 'function'
    ? { kernel: kernelOrOptions }
    : (kernelOrOptions || {});
  const envKernelOpts = options.kernel ? {} : buildKernelOptsFromEnv();
  const kernel = options.kernel || createKernelFromEnv();
  const approvalStore = createApprovalStoreFromKernel(kernel, { ...envKernelOpts, ...options });
  const operatorToken = options.operatorToken || process.env[MCP_OPERATOR_TOKEN_ENV] || '';
  return {
    kernel,
    approvalStore,
    operatorToken,
    handleRequest(message) {
      if (!message || typeof message !== 'object') {
        return { jsonrpc: '2.0', error: { code: -32600, message: 'Invalid Request' } };
      }

      const { id, method, params } = message;

      if (method === 'initialize') {
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          },
        };
      }

      if (method === 'notifications/initialized') {
        return null;
      }

      if (method === 'ping') {
        return { jsonrpc: '2.0', id, result: {} };
      }

      if (method === 'tools/list') {
        return { jsonrpc: '2.0', id, result: { tools: MODEL_VISIBLE_TOOL_SCHEMAS } };
      }

      if (method === 'tools/call') {
        try {
          const result = callTool(kernel, params, { approvalStore, operatorToken });
          return { jsonrpc: '2.0', id, result: toToolResult(result) };
        } catch (err) {
          const errorRef = recordInternalError('tools/call', err);
          return {
            jsonrpc: '2.0',
            id,
            result: {
              content: [{ type: 'text', text: `INTERNAL_ERROR (ref: ${errorRef})` }],
              isError: true,
            },
          };
        }
      }

      if (method === 'shutdown') {
        return { jsonrpc: '2.0', id, result: {} };
      }

      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
    },
  };
}

function buildApprovalAdmissionOptions(approval, args = {}) {
  const approvalKey = approval.approvalKey || approval.approval_key || approval.id;
  return {
    skipConflicts: args.skipConflicts !== false,
    maxSentences: args.maxSentences,
    workspaceId: 'default',
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: approval.id,
    sourceType: 'mcp_approval',
    sourceRef: approvalKey,
    actor: 'mcp-approval',
    provenance: {
      provenanceId: `prov_mcp_${approval.id}`,
      sourceType: 'mcp_approval',
      sourceRef: approvalKey,
      actor: 'mcp-approval',
      workspaceId: 'default',
      timestamp: new Date().toISOString(),
      trustPolicyVersion: kernelContractVersion(approval),
    },
  };
}

function kernelContractVersion(approval) {
  return approval?.policy?.gate?.metadata?.contractVersion || 'mcp-approval';
}

function failApprovalDecision(code, message, meta = {}) {
  return {
    ok: false,
    type: 'approval',
    data: null,
    evidence: [],
    error: { code, message },
    meta,
  };
}

function handleMcpApprovalDecision(kernel, args = {}, runtime = {}) {
  const approvalStore = runtime.approvalStore || createApprovalStoreFromKernel(kernel, runtime);
  if (!approvalStore ||
      typeof approvalStore.getToolApprovalById !== 'function' ||
      typeof approvalStore.claimToolApproval !== 'function' ||
      typeof approvalStore.rejectToolApproval !== 'function' ||
      typeof approvalStore.failToolApproval !== 'function' ||
      typeof approvalStore.resolveToolApproval !== 'function') {
    return failApprovalDecision('APPROVAL_STORE_UNAVAILABLE', 'Persistent MCP approval store is unavailable.');
  }

  const approvalId = sanitizeMcpString(args.approvalId, MCP_MAX_SHORT);
  if (!approvalId) {
    return failApprovalDecision('APPROVAL_ID_REQUIRED', 'approvalId is required.');
  }

  // #615: only a genuinely absent decision field defaults to 'approved'.
  // A present-but-invalid value (wrong enum, empty string, whitespace) must
  // fail closed rather than silently falling into the most privileged
  // branch -- args.decision || 'approved' could not tell those cases apart.
  const decisionProvided = args.decision !== undefined && args.decision !== null;
  const decision = sanitizeMcpApprovalDecision(decisionProvided ? args.decision : 'approved');
  if (!decision) {
    return failApprovalDecision('INVALID_APPROVAL_DECISION', 'decision must be "approved" or "rejected".');
  }
  const reason = sanitizeMcpString(args.reason || `mcp_${decision}`, MCP_MAX_TEXT);
  const existing = formatApprovalRecord(approvalStore.getToolApprovalById(approvalId));
  if (!existing) {
    return failApprovalDecision('APPROVAL_NOT_FOUND', `Approval not found: ${approvalId}`);
  }

  if (existing.status === 'approved' || existing.status === 'rejected') {
    if (existing.status !== decision) {
      return failApprovalDecision('APPROVAL_ALREADY_FINAL', `Approval is already ${existing.status}.`, { approval: existing });
    }
    return {
      ok: true,
      type: 'approval',
      data: { approval: existing, decision, executed: false, idempotent: true, result: null },
      evidence: [],
      error: null,
      meta: { idempotent: true },
    };
  }

  if (decision === 'rejected') {
    const rejection = approvalStore.rejectToolApproval(approvalId, reason);
    if (!rejection || rejection.rejected !== true) {
      const current = formatApprovalRecord(rejection?.approval || approvalStore.getToolApprovalById(approvalId));
      return failApprovalDecision(
        'APPROVAL_DECISION_CONFLICT',
        'Approval is already claimed or is not pending.',
        { approval: current, retrySafe: false },
      );
    }
    const rejected = formatApprovalRecord(rejection.approval);
    return {
      ok: true,
      type: 'approval',
      data: { approval: rejected, decision, executed: false, idempotent: false, result: null },
      evidence: [],
      error: null,
      meta: {},
    };
  }

  // Canonicalized rather than compared literally: approvals persisted before
  // the RFC-001 rename carry `tool: "axiom.learn"`, and those rows must stay
  // executable. Comparing the raw string would have silently made every
  // pre-rename pending approval permanently unapprovable.
  if (canonicalMcpToolName(existing.tool) !== 'huqan.learn') {
    return failApprovalDecision('APPROVAL_EXECUTION_UNSUPPORTED', `Approval execution is only supported for huqan.learn, got ${existing.tool}.`, { approval: existing });
  }

  const claim = approvalStore.claimToolApproval(approvalId, reason);
  if (!claim || claim.claimed !== true) {
    const current = formatApprovalRecord(claim?.approval || approvalStore.getToolApprovalById(approvalId));
    if (current?.status === 'approved') {
      return {
        ok: true,
        type: 'approval',
        data: { approval: current, decision, executed: false, idempotent: true, result: null },
        evidence: [],
        error: null,
        meta: { idempotent: true },
      };
    }
    const code = current?.status === 'failed'
      ? 'APPROVAL_RECONCILIATION_REQUIRED'
      : current?.status === 'executing'
        ? 'APPROVAL_EXECUTION_IN_PROGRESS'
        : 'APPROVAL_DECISION_CONFLICT';
    return failApprovalDecision(
      code,
      current?.status === 'failed'
        ? 'Approval execution outcome is unknown and requires manual reconciliation.'
        : 'Approval execution is already claimed or is not pending.',
      { approval: current, retrySafe: false },
    );
  }

  const storedArgs = existing.context?.args && typeof existing.context.args === 'object'
    ? existing.context.args
    : parseJsonObject(existing.input, {});
  const cleanArgs = sanitizeToolArgsForStorage(existing.tool, storedArgs);
  const learnOptions = buildApprovalAdmissionOptions(existing, cleanArgs);
  // #216: both the SQLite and JSON Graph backends now provide a crash-safe
  // durable mutation journal (runMutationOnce), so binding the durable id no
  // longer depends on which backend is active -- runMutationOnce's presence
  // is itself the capability signal now that it is real on both.
  if (kernel.graph && typeof kernel.graph.runMutationOnce === 'function') {
    learnOptions.mutationOperationId = approvalId;
  }
  let result;
  try {
    result = kernel.learn(cleanArgs.text, learnOptions);
  } catch (error) {
    const failure = approvalStore.failToolApproval(
      approvalId,
      `execution_outcome_unknown:${error?.code || error?.name || 'error'}`
    );
    const failed = formatApprovalRecord(failure?.approval || approvalStore.getToolApprovalById(approvalId));
    return failApprovalDecision(
      'APPROVAL_EXECUTION_FAILED',
      'Approved MCP action threw during execution; outcome requires manual reconciliation.',
      { approval: failed, retrySafe: false },
    );
  }
  if (!result || result.ok === false) {
    const failure = approvalStore.failToolApproval(approvalId, 'execution_outcome_unknown:result_not_ok');
    const failed = formatApprovalRecord(failure?.approval || approvalStore.getToolApprovalById(approvalId));
    return failApprovalDecision(
      'APPROVAL_EXECUTION_FAILED',
      'Approved MCP action failed; outcome requires manual reconciliation.',
      { approval: failed, result, retrySafe: false },
    );
  }

  let approved;
  try {
    approved = formatApprovalRecord(approvalStore.resolveToolApproval(approvalId, 'approved', reason));
  } catch (error) {
    return failApprovalDecision(
      'APPROVAL_FINALIZATION_FAILED',
      'Approved MCP action executed but finalizing the approval record threw an error.',
      {
        approval: formatApprovalRecord(approvalStore.getToolApprovalById(approvalId)),
        result,
        retrySafe: false,
        finalizationError: error?.code || error?.name || 'error',
      },
    );
  }
  if (!approved || approved.status !== 'approved') {
    return failApprovalDecision(
      'APPROVAL_FINALIZATION_FAILED',
      'Approved MCP action executed but the approval record could not be finalized.',
      { approval: approved || formatApprovalRecord(approvalStore.getToolApprovalById(approvalId)), result, retrySafe: false },
    );
  }
  return {
    ok: true,
    type: 'approval',
    data: { approval: approved, decision, executed: true, idempotent: false, result },
    evidence: result.evidence || [],
    error: null,
    meta: { admissionAware: true },
  };
}

/**
 * Run `callback` with a throwaway agent and close that agent's storage
 * afterwards.
 *
 * The close must wait for an async callback to settle (#409). A plain
 * `finally` runs as soon as the callback *returns* -- for a callback that
 * returns a promise that is the moment the promise is created, not the moment
 * the work finishes, so storage was closed out from under the in-flight
 * operation and any later use hit a closed handle.
 *
 * Every current callback (agent.plan / agent.run / agent.inspectToolPolicy) is
 * synchronous, so this is a latent bug rather than an active one today. The
 * thenable branch below keeps it latent: if any of those ever becomes async,
 * the close follows the work instead of racing it.
 */
function withTransientAgent(kernel, callback) {
  const agent = createAgent({
    kernel,
    version: readCompatibleEnvironmentVariable('AGENT_VERSION'),
  });
  const closeStorage = () => {
    try { agent?.storage?.close?.(); } catch (_) {}
  };

  let result;
  try {
    result = callback(agent);
  } catch (error) {
    closeStorage();
    throw error;
  }

  if (result && typeof result.then === 'function') {
    return result.then(
      (value) => { closeStorage(); return value; },
      (error) => { closeStorage(); throw error; },
    );
  }

  closeStorage();
  return result;
}

/**
 * RFC-001 reader half: accept both spellings, resolve to one handler.
 *
 * The requested name is canonicalized once, here, and every downstream
 * consumer — gate evaluation, approval persistence, dispatch, dry-run — sees
 * only the canonical `huqan.*` name. That is what makes "both names resolve to
 * the same handler" structural rather than a pair of parallel switch arms that
 * could drift.
 */
function callTool(kernel, params = {}, runtime = {}) {
  const safeParams = params && typeof params === 'object' ? params : {};
  const requestedName = sanitizeMcpString(safeParams.name, MCP_MAX_SHORT);
  const outcome = dispatchMcpTool(kernel, canonicalMcpToolName(requestedName), safeParams, runtime);
  if (!isLegacyMcpToolName(requestedName)) return outcome;
  if (outcome && typeof outcome.then === 'function') {
    return outcome.then((value) => withMcpToolDeprecationSurface(value, requestedName));
  }
  return withMcpToolDeprecationSurface(outcome, requestedName);
}

function dispatchMcpTool(kernel, name, safeParams, runtime = {}) {
  const args = parseJsonObject(safeParams.arguments, {});

  if (name === 'huqan.approve' || name === 'huqan.approvals') {
    if (!isMcpOperatorAuthorized(runtime.operatorToken, safeParams.operatorToken)) {
      return failApprovalDecision('OPERATOR_AUTH_REQUIRED', 'A separate operator capability is required for MCP approval operations.');
    }
    if (name === 'huqan.approve') return handleMcpApprovalDecision(kernel, args, runtime);
  }

  const gate = applyHumanApprovalToggle(evaluateMcpGate({ tool: name, args, metadata: {} }));
  emitGateTelemetry(kernel, 'mcp-tool-call', { decision: gate.decision, reason: gate.reason, findings: gate.findings, metadata: gate.metadata });

  if (!gate.canExecute) {
    if (gate.decision === 'review' || gate.requiredReview) {
      const approvalStore = runtime.approvalStore || createApprovalStoreFromKernel(kernel, runtime);
      const approval = saveMcpApproval(approvalStore, name, args, gate);
      const gateSurface = {
        decision: gate.decision,
        allowed: gate.allowed,
        canExecute: gate.canExecute,
        canDryRun: gate.canDryRun,
        requiredReview: gate.requiredReview,
        reason: gate.reason,
        metadata: { policyVersion: gate.metadata?.adapterVersion || 'V2.6-PR2' },
      };
      // "Queued for review" is a claim about durable state. Without a stored
      // approval there is no queue and no one to review it, so the caller is
      // told that instead -- the mutation is blocked either way (#772).
      if (approval.persisted !== true) {
        return withMcpToolVerdictSurface({
          ok: false,
          gate: gateSurface,
          approval,
          error: {
            code: 'REVIEW_NOT_PERSISTED',
            reason: approval.notPersistedReason || 'approval_store_unavailable',
            message: 'Tool call requires review, but no durable approval was recorded; nothing was queued and nothing executed.',
          },
          message: `Tool call blocked, review not persisted: ${gate.reason}`,
        }, name, args, gate);
      }
      return withMcpToolVerdictSurface({
        ok: false,
        gate: gateSurface,
        approval,
        message: `Tool call queued for review: ${gate.reason}`,
      }, name, args, gate);
    }
    if (gate.canDryRun) {
      const dryRunResult = executeReadOnlyDryRun(kernel, name, args);
      return withMcpToolVerdictSurface({
        ok: true,
        dryRun: true,
        gate: {
          decision: gate.decision,
          allowed: gate.allowed,
          canExecute: gate.canExecute,
          canDryRun: gate.canDryRun,
          requiredReview: gate.requiredReview,
          reason: gate.reason,
          metadata: { policyVersion: gate.metadata?.adapterVersion || 'V2.6-PR2' },
        },
        result: dryRunResult,
        message: `Tool dry-run: ${gate.reason}`,
      }, name, args, gate);
    }
    return withMcpToolVerdictSurface({
      ok: false,
      gate: {
        decision: gate.decision,
        allowed: gate.allowed,
        canExecute: gate.canExecute,
        canDryRun: gate.canDryRun,
        requiredReview: gate.requiredReview,
        reason: gate.reason,
        metadata: { policyVersion: gate.metadata?.adapterVersion || 'V2.6-PR2' },
      },
      message: `Tool call blocked by gate: ${gate.reason}`,
    }, name, args, gate);
  }

  switch (name) {
    case 'huqan.learn':
      return withMcpToolVerdictSurface(kernel.learn(sanitizeMcpString(args.text, MCP_MAX_TEXT), {
        skipConflicts: args.skipConflicts !== false,
        maxSentences: args.maxSentences,
      }), name, args, gate);
    case 'huqan.ask':
      return withMcpToolVerdictSurface(kernel.ask(sanitizeMcpString(args.question)), name, args, gate);
    case 'huqan.verify':
      return withMcpToolVerdictSurface(kernel.verify(sanitizeMcpString(args.statement)), name, args, gate);
    case 'huqan.plan':
      return withTransientAgent(kernel, (agent) => withMcpToolVerdictSurface(
        agent.plan(sanitizeMcpString(args.goal, MCP_MAX_GOAL), {
          maxSteps: boundedMcpInteger(args.maxSteps, 4, 1, 8),
        }),
        name,
        args,
        gate,
      ));
    case 'huqan.agent':
      return withTransientAgent(kernel, async (agent) => withMcpToolVerdictSurface(
        await agent.run(sanitizeMcpString(args.goal, MCP_MAX_GOAL), {
          maxSteps: boundedMcpInteger(args.maxSteps, 4, 1, 8),
        }),
        name,
        args,
        gate,
      ));
    case 'huqan.policy':
      return withTransientAgent(kernel, (agent) => withMcpToolVerdictSurface(
        agent.inspectToolPolicy(
          sanitizeMcpString(args.tool),
          sanitizeMcpString(args.input || '', MCP_MAX_TEXT),
          { goal: sanitizeMcpString(args.goal, MCP_MAX_GOAL) },
        ),
        name,
        args,
        gate,
      ));
    case 'huqan.approvals':
      const approvalStore = runtime.approvalStore || createApprovalStoreFromKernel(kernel, runtime);
      const approvalLimit = boundedMcpInteger(args.limit, 50, 1, 50);
      const storedApprovals = listPersistentApprovals(approvalStore, approvalLimit);
      return withMcpToolVerdictSurface({
        pendingCount: countPersistentApprovals(approvalStore),
        unresolvedCount: countUnresolvedApprovals(approvalStore),
        approvals: storedApprovals.slice(0, approvalLimit),
      }, name, args, gate);
    case 'huqan.reason':
      return withMcpToolVerdictSurface(kernel.reason(sanitizeMcpString(args.subject)), name, args, gate);
    case 'huqan.compare':
      return withMcpToolVerdictSurface(kernel.compare(
        sanitizeMcpString(args.left),
        sanitizeMcpString(args.right),
      ), name, args, gate);
    case 'huqan.dream':
      return withMcpToolVerdictSurface(kernel.dream({
        depth: boundedMcpInteger(args.depth, 2, 1, 5),
      }), name, args, gate);
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function executeReadOnlyDryRun(kernel, requestedName, args) {
  // callTool already canonicalizes, but this is exported and called directly by
  // tests and tooling, so it resolves the alias itself rather than relying on
  // its caller having done so.
  const name = canonicalMcpToolName(requestedName);
  switch (name) {
    case 'huqan.learn':
      return kernel.ask(`What would be learned from: ${(args.text || '').slice(0, 200)}`);
    case 'huqan.agent':
      return withTransientAgent(kernel, (agent) => (
        agent.plan
          ? agent.plan(sanitizeMcpString(args.goal, MCP_MAX_GOAL), {
            maxSteps: boundedMcpInteger(args.maxSteps, 1, 1, 8),
          })
          : { dryRun: true, goal: args.goal }
      ));
    default:
      return { dryRun: true, tool: name, args: scrubSecrets(args).scrubbed };
  }
}

function runStdio() {
  const server = createServer();
  const rl = readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
  });

  // Serializing the response can itself throw (a circular structure or a
  // BigInt reaching JSON.stringify), and this runs inside a stdin event
  // handler where an escaping throw is fatal. Fall back to a fixed,
  // always-serializable envelope rather than taking the process down.
  function send(msg) {
    let payload;
    try {
      payload = JSON.stringify(msg);
    } catch (err) {
      const errorRef = recordInternalError('stdio/serialize', err);
      payload = JSON.stringify({
        jsonrpc: '2.0',
        id: (msg && typeof msg === 'object' && msg.id !== undefined) ? msg.id : null,
        error: { code: -32603, message: `Internal error (ref: ${errorRef})` },
      });
    }
    process.stdout.write(`${payload}\n`);
  }

  rl.on('line', line => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let message;
    try {
      message = JSON.parse(trimmed);
    } catch (err) {
      send({ jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } });
      return;
    }

    // `handleRequest` guards its own `tools/call` branch, but every other
    // branch is unguarded and this is an event handler -- an escaping throw
    // takes the whole MCP server down mid-session instead of failing the one
    // request (#414). A malformed request must never be able to do that.
    try {
      const response = server.handleRequest(message);
      if (response) send(response);
    } catch (err) {
      const errorRef = recordInternalError('stdio/handleRequest', err);
      send({
        jsonrpc: '2.0',
        id: (message && typeof message === 'object' && message.id !== undefined) ? message.id : null,
        error: { code: -32603, message: `Internal error (ref: ${errorRef})` },
      });
    }

    if (message && message.method === 'shutdown') {
      rl.close();
      setTimeout(() => process.exit(0), 0).unref?.();
    }
  });

  process.stdin.on('end', () => rl.close());
}

if (require.main === module) {
  runStdio();
}

module.exports = {
  PROTOCOL_VERSION,
  SERVER_NAME,
  TOOL_SCHEMAS,
  MODEL_VISIBLE_TOOL_SCHEMAS,
  MCP_OPERATOR_TOKEN_ENV,
  CANONICAL_MCP_TOOL_NAMES,
  LEGACY_MCP_TOOL_NAMES,
  VERIFY_STATUS,
  buildKernelOptsFromEnv,
  createKernelFromEnv,
  createApprovalStoreFromKernel,
  callTool,
  createServer,
  runStdio,
  recordInternalError,
  sanitizeToolArgsForStorage,
  executeReadOnlyDryRun,
  withTransientAgent,
};
