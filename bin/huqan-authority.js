#!/usr/bin/env node
'use strict';

/**
 * huqan-authority (#3860, ADR-016): the runtime's side of the approval
 * authority.
 *
 *   huqan-authority status                  which authority this runtime answers to,
 *                                           and whether the pinned service answers
 *   huqan-authority sync [--workspace <id>] register pending local approvals with it
 *   huqan-authority decide                  where the operator decides (it does not open it)
 *   huqan-authority withdraw <approvalId>   where the operator takes back an approved decision nobody has consumed
 *   huqan-authority apply <approvalId> [--workspace <id>]
 *                                           fetch the operator's signed decision,
 *                                           consume it, carry it out, record the outcome
 *   huqan-authority request <tool> [--workspace <id>] --args <json>
 *                                           register an operator action that has no
 *                                           approval row (agent resume, emergency-stop
 *                                           lift, terfi, autonomy activation; #3892)
 *
 * Exit 0 on success. Exit 2 when an authority is required or installed but
 * cannot be used, answers as something other than the pinned service, or
 * refuses. Exit 3 when the approval is still waiting for the operator.
 */

const crypto = require('node:crypto');
const { resolveApprovalAuthorityMode } = require('../lib/authority/authority-mode');
const { createAuthorityClient } = require('../lib/authority/authority-client');
const { buildRegistration, buildOperationalRegistration, consumeProofFor, storedArgumentsOf } = require('../lib/authority/registration-payload');
const { OPERATIONAL_TOOLS, isOperationalTool } = require('../lib/authority/operational-guard');
const { loadOrCreateConsumeKey } = require('../lib/authority/consume-key');
const { listPersistentApprovals, formatApprovalRecord } = require('../lib/mcp-approval-views');
const { requireAuthorityDecision } = require('../lib/authority/decision-guard');
const { resolveMcpApprovalTtlMs } = require('../lib/mcp-approval-expiry');

const USAGE = 'usage: huqan-authority status | sync [--workspace <id>] | decide | withdraw <approvalId>'
  + ' | apply <approvalId> [--workspace <id>] | request <tool> [--workspace <id>] --args <json>';
const OPERATIONAL_PREFIX = 'ops-';
const OPERATIONAL_ACTOR = 'operator:authority';
const MAX_SYNC = 500;

function openLocalRuntime() {
  const { createServer, callTool } = require('../mcpServer');
  const server = createServer();
  const operatorToken = crypto.randomBytes(32).toString('hex');
  return {
    approvalStore: server.approvalStore,
    // Checks the local row against the signed decision before anything is
    // consumed at the authority, so a decision that cannot run here is never
    // spent there.
    preflight: ({ approvalId, workspaceId, envelope, mode }) => {
      const row = formatApprovalRecord(server.approvalStore.getToolApprovalById(approvalId, workspaceId));
      if (!row) return { ok: false, code: 'APPROVAL_NOT_FOUND' };
      if (row.status !== 'pending') return { ok: true, alreadyFinal: row.status };
      return requireAuthorityDecision({ mode, existing: row, approvalId, workspaceId, decision: envelope.payload.decision,
        storedArgs: storedArgumentsOf(row), envelope, now: Date.now(), checkConsumption: false });
    },
    approve: async ({ approvalId, workspaceId, decision, envelope, consumption, mode }) => callTool(server.kernel, {
      name: 'huqan.approve', operatorToken, arguments: { approvalId, workspaceId, decision },
    }, { approvalStore: server.approvalStore, operatorToken, approvalAuthorityMode: mode, authorityDecision: envelope,
      authorityConsumption: consumption }),
    close: () => { server.kernel.graph?.close?.(); server.approvalStore?.close?.(); },
  };
}

// The executors for operational approvals (#3892). Each gets the authority's
// envelopes in-process and hands them to the surface, which verifies them
// against the arguments it acts on: this file never decides on its own.
const OPERATIONAL_EXECUTORS = Object.freeze({
  [OPERATIONAL_TOOLS.EMERGENCY_STOP]: ({ args, authority }) => {
    if (args.action !== 'lift') return { ok: false, error: { code: 'INVALID_ACTION', message: 'only a lift is decided by the authority' } };
    const { emergencyStopLedger } = require('../lib/emergency-stop');
    const result = emergencyStopLedger().lift({ scope: args.scope, workspaceId: args.workspaceId, agentId: args.agentId || undefined,
      reason: args.reason, actor: OPERATIONAL_ACTOR, authority });
    return result.ok ? { ok: true, data: { lifted: result.lifted } } : { ok: false, error: { code: result.reason } };
  },
  [OPERATIONAL_TOOLS.AGENT_RESUME]: async ({ args, authority }) => {
    const { createServer, callTool } = require('../mcpServer');
    const server = createServer();
    const operatorToken = crypto.randomBytes(32).toString('hex');
    try {
      return await callTool(server.kernel, { name: OPERATIONAL_TOOLS.AGENT_RESUME, operatorToken, arguments: args },
        { approvalStore: server.approvalStore, operatorToken, approvalAuthorityMode: authority.mode,
          authorityApprovalId: authority.approvalId, authorityDecision: authority.envelope, authorityConsumption: authority.consumption });
    } finally {
      server.kernel.graph?.close?.();
      server.approvalStore?.close?.();
    }
  },
  [OPERATIONAL_TOOLS.PROMOTE]: async ({ args, authority }) => {
    const CLI = require('../cli');
    const cli = new CLI();
    try {
      const output = await cli.execute('terfi', args.argv, { authority, json: true });
      let report = null;
      try { report = JSON.parse(output); } catch { /* a gate refusal answers in text */ }
      // terfi refuses inside its loop without throwing; only a promotion or rollback that happened is executed.
      if (!report || report.ok !== true || report.moved !== true) {
        return { ok: false, error: { code: 'PROMOTION_NOT_MOVED', message: typeof output === 'string' ? output.slice(0, 512) : 'no report' } };
      }
      return { ok: true, data: report };
    } finally {
      // Every store the CLI opened: an open SQLite handle at exit crashes the process on Windows.
      for (const store of [cli.agent?.storage, cli.approvalStore, cli.kernel.graph, cli.kernel.memory]) {
        try { store?.close?.(); } catch { /* already closed */ }
      }
    }
  },
  // The consumption itself is the activation: the gate hook reads it back.
  [OPERATIONAL_TOOLS.AUTONOMY_ACTIVATION]: () => ({ ok: true, data: { activated: true } }),
});

function defaults(deps) {
  return { resolveMode: resolveApprovalAuthorityMode, createClient: createAuthorityClient, openRuntime: openLocalRuntime,
    loadConsumeKey: loadOrCreateConsumeKey, ttlMs: () => resolveMcpApprovalTtlMs(), executors: OPERATIONAL_EXECUTORS,
    now: Date.now, ...deps };
}

function serviceOrRefusal(mode) {
  if (mode.mode === 'service') return null;
  return { code: 2, report: { mode: mode.mode, reason: mode.reason || 'no approval authority is installed', pinPath: mode.pinPath } };
}

async function status(deps = {}) {
  const { resolveMode, createClient } = defaults(deps);
  const mode = resolveMode();
  if (mode.mode === 'legacy') {
    return { code: 0, report: { mode: 'legacy', boundary: mode.boundary,
      note: 'no approval authority is installed; operator decisions are protected only by the same OS user' } };
  }
  if (mode.mode !== 'service') return { code: 2, report: { mode: mode.mode, reason: mode.reason, pinPath: mode.pinPath } };
  const base = { mode: 'service', boundary: mode.boundary, pinPath: mode.pinPath, port: mode.pin.port, keyId: mode.pin.keyId };
  try {
    const identity = await createClient({ pin: mode.pin }).identity();
    // Signed is not enough: the service must answer 200 under the very key the pin names.
    if (identity.status !== 200 || !identity.body || identity.body.keyId !== mode.pin.keyId) {
      return { code: 2, report: { ...base, answering: false, error: 'AUTHORITY_IDENTITY_MISMATCH' } };
    }
    return { code: 0, report: { ...base, answering: true } };
  } catch (error) {
    return { code: 2, report: { ...base, answering: false, error: error.code || 'STATUS_FAILED' } };
  }
}

async function sync({ workspaceId = 'default' } = {}, deps = {}) {
  const { resolveMode, createClient, openRuntime, loadConsumeKey, ttlMs } = defaults(deps);
  const mode = resolveMode();
  const refusal = serviceOrRefusal(mode);
  if (refusal) return refusal;
  const client = createClient({ pin: mode.pin });
  const consumeKey = loadConsumeKey();
  const runtime = openRuntime();
  try {
    const pending = listPersistentApprovals(runtime.approvalStore, MAX_SYNC, workspaceId).filter(a => a.status === 'pending');
    const results = [];
    for (const approval of pending) {
      const body = buildRegistration(approval, { consumeKey, ttlMs: ttlMs() });
      if (!body) { results.push({ approvalId: approval.id, registered: false, code: 'NO_EXPIRY' }); continue; }
      const answer = await client.register(body);
      results.push({ approvalId: approval.id, registered: answer.status === 200 || answer.status === 201,
        ...(answer.body?.code ? { code: answer.body.code } : {}) });
    }
    return { code: results.every(r => r.registered) ? 0 : 2, report: { workspaceId, results } };
  } finally {
    runtime.close();
  }
}

async function consumeOnce(client, approvalId, fetched, consumeProof) {
  if (fetched.body.consumption) return { consumption: fetched.body.consumption };
  const consumed = await client.consume(approvalId, { actionHash: fetched.body.envelope.payload.actionHash, consumeProof });
  if (consumed.status !== 200) return { error: consumed.body?.code || `HTTP_${consumed.status}` };
  return { consumption: consumed.body.consumption };
}

async function request(tool, { workspaceId = 'default', argsJson } = {}, deps = {}) {
  const { resolveMode, createClient, loadConsumeKey, ttlMs, now } = defaults(deps);
  if (!isOperationalTool(tool)) {
    return { code: 1, report: { tool, error: 'NOT_OPERATIONAL', operational: Object.values(OPERATIONAL_TOOLS) } };
  }
  let args;
  try {
    args = JSON.parse(argsJson);
  } catch {
    args = null;
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return { code: 1, report: { tool, error: 'ARGS_NOT_AN_OBJECT' } };
  const mode = resolveMode();
  const refusal = serviceOrRefusal(mode);
  if (refusal) return refusal;
  const body = buildOperationalRegistration({ tool, workspaceId, args, consumeKey: loadConsumeKey(), now: now(), ttlMs: ttlMs() });
  const answer = await createClient({ pin: mode.pin }).register(body);
  if (answer.status !== 200 && answer.status !== 201) {
    return { code: 2, report: { tool, error: answer.body?.code || `HTTP_${answer.status}`,
      ...(answer.body?.reason ? { reason: answer.body.reason } : {}) } };
  }
  return { code: 0, report: { approvalId: body.approvalId, tool: body.tool, workspaceId, expiresAt: body.expiresAt,
    next: `decide it in the HUQAN Authority window, then run huqan-authority apply ${body.approvalId}` } };
}

async function runOperational(approvalId, fetched, { client, mode, consumeProof, executors, workspaceId: requestedWorkspace }) {
  const envelope = fetched.body.envelope;
  const decision = envelope.payload.decision;
  if (decision !== 'approved') return { code: 0, report: { approvalId, decision, executed: false } };
  const shown = await client.show(approvalId);
  const approval = shown.status === 200 ? shown.body?.approval : null;
  if (!approval || !isOperationalTool(approval.tool)) return { code: 2, report: { approvalId, decision, error: 'NOT_OPERATIONAL' } };
  if (requestedWorkspace !== undefined && requestedWorkspace !== approval.workspaceId) {
    return { code: 2, report: { approvalId, decision, error: 'WORKSPACE_MISMATCH' } };
  }
  // The recorded outcome is what makes a second apply change nothing; a crash
  // after consuming and before the outcome leaves it re-runnable, as in P4.
  if (approval.outcome) return { code: 0, report: { approvalId, decision, alreadyFinal: approval.outcome.status } };
  // Checked before anything is spent: a decision that does not cover these
  // arguments is never consumed.
  const preflight = requireAuthorityDecision({ mode, existing: { tool: approval.tool }, approvalId, workspaceId: approval.workspaceId,
    decision, storedArgs: approval.arguments, envelope, now: Date.now(), checkConsumption: false });
  if (!preflight.ok) return { code: 2, report: { approvalId, decision, error: preflight.code } };
  const once = await consumeOnce(client, approvalId, fetched, consumeProof);
  if (once.error) return { code: 2, report: { approvalId, decision, error: once.error } };
  let result;
  try {
    result = await executors[approval.tool]({ args: approval.arguments, workspaceId: approval.workspaceId,
      authority: { mode, approvalId, envelope, consumption: once.consumption } });
  } catch (error) {
    result = { ok: false, error: { code: error.exitCode ? 'EXECUTION_REFUSED' : 'EXECUTION_THREW', message: error.message } };
  }
  const report = { approvalId, decision, tool: approval.tool, executed: result.ok === true,
    ...(result.ok ? {} : { error: result.error?.code, message: result.error?.message }) };
  // The action already ran. Without a recorded outcome a second apply would run
  // it again, so an unrecorded outcome is its own failure and says so.
  let recorded;
  try {
    recorded = await client.recordOutcome(approvalId, { status: result.ok ? 'executed' : 'failed',
      receiptId: String(result.ok ? approvalId : result.error?.code || 'failed'), receiptHash: null, consumeProof });
  } catch (error) {
    recorded = { status: 0, body: { code: error.code || 'AUTHORITY_UNAVAILABLE' } };
  }
  if (recorded.status !== 200) {
    return { code: 2, report: { ...report, outcomeRecorded: false, outcomeError: recorded.body?.code || `HTTP_${recorded.status}`,
      note: 'the action ran but the authority did not record its outcome; do not apply again before checking what happened' } };
  }
  return { code: result.ok ? 0 : 2, report };
}

async function apply(approvalId, { workspaceId: requestedWorkspace } = {}, deps = {}) {
  const { resolveMode, createClient, openRuntime, loadConsumeKey, executors } = defaults(deps);
  const mode = resolveMode();
  const refusal = serviceOrRefusal(mode);
  if (refusal) return refusal;
  const client = createClient({ pin: mode.pin });
  const fetched = await client.getDecision(approvalId);
  if (fetched.status !== 200) return { code: 2, report: { approvalId, error: fetched.body?.code || `HTTP_${fetched.status}` } };
  if (!fetched.body.envelope) return { code: 3, report: { approvalId, status: 'pending', next: 'decide it in the HUQAN Authority window' } };
  if (fetched.body.withdrawal) {
    return { code: 2, report: { approvalId, error: 'WITHDRAWN', withdrawal: fetched.body.withdrawal,
      note: 'the operator withdrew this decision before it was consumed; nothing was carried out' } };
  }
  if (approvalId.startsWith(OPERATIONAL_PREFIX)) {
    return runOperational(approvalId, fetched, { client, mode, executors, workspaceId: requestedWorkspace,
      consumeProof: consumeProofFor(loadConsumeKey(), approvalId) });
  }
  const envelope = fetched.body.envelope;
  const decision = envelope.payload.decision;
  // The signed envelope names the workspace; preflight still checks it against the row.
  const workspaceId = requestedWorkspace ?? envelope.payload.workspaceId;
  if (workspaceId !== envelope.payload.workspaceId) {
    return { code: 2, report: { approvalId, decision, error: 'WORKSPACE_MISMATCH' } };
  }
  const consumeProof = consumeProofFor(loadConsumeKey(), approvalId);
  const runtime = openRuntime();
  try {
    const preflight = runtime.preflight({ approvalId, workspaceId, envelope, mode });
    if (!preflight.ok) return { code: 2, report: { approvalId, decision, error: preflight.code } };
    if (preflight.alreadyFinal) return { code: 0, report: { approvalId, decision, alreadyFinal: preflight.alreadyFinal } };
    let consumption;
    if (decision === 'approved') {
      const once = await consumeOnce(client, approvalId, fetched, consumeProof);
      if (once.error) return { code: 2, report: { approvalId, decision, error: once.error } };
      consumption = once.consumption;
    }
    let result;
    try {
      result = await runtime.approve({ approvalId, workspaceId, decision, envelope, consumption, mode });
    } catch (error) {
      result = { ok: false, error: { code: 'EXECUTION_THREW', message: error.message } };
    }
    if (decision === 'approved') {
      await client.recordOutcome(approvalId, { status: result.ok ? 'executed' : 'failed',
        receiptId: String(result.ok ? approvalId : result.error?.code || 'failed'), receiptHash: null, consumeProof });
    }
    return { code: result.ok ? 0 : 2, report: { approvalId, decision,
      executed: result.ok === true && result.data?.executed === true, ...(result.ok ? {} : { error: result.error?.code }) } };
  } finally {
    runtime.close();
  }
}

// This tool lives in a user-writable checkout. If it launched the operator
// window elevated, an agent could edit it to launch anything elevated behind
// the operator's UAC click. So it only says where the protected window is.
function decide(deps = {}) {
  const { resolveMode } = defaults(deps);
  const mode = resolveMode();
  if (mode.mode !== 'service') return { code: 2, report: { mode: mode.mode, reason: mode.reason || 'no approval authority is installed' } };
  return { code: 0, report: { next: 'Open "HUQAN Authority" from the Start menu. It runs elevated from the protected install, '
    + 'shows each pending approval with the arguments it is bound to, and asks for your authenticator code; '
    + 'then run huqan-authority apply <approvalId> here.' } };
}

// Like decide: the code is typed only in the protected operator window.
function withdraw(approvalId, deps = {}) {
  const { resolveMode } = defaults(deps);
  const mode = resolveMode();
  if (mode.mode !== 'service') return { code: 2, report: { mode: mode.mode, reason: mode.reason || 'no approval authority is installed' } };
  return { code: 0, report: { approvalId, next: 'Open "HUQAN Authority" from the Start menu and choose withdraw (w) for this '
    + 'approval. It works only while the decision is approved and not yet consumed.' } };
}

function takeFlag(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? { value: args[i + 1], rest: args.filter((_, j) => j !== i && j !== i + 1) } : { rest: args };
}

function parseWorkspace(args) {
  const { value, rest } = takeFlag(args, '--workspace');
  return { workspaceId: value, rest };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const [command, ...args] = argv;
  const { workspaceId, rest } = parseWorkspace(args);
  let outcome;
  if (command === 'status' && args.length === 0) outcome = await status(deps);
  else if (command === 'sync' && rest.length === 0) outcome = await sync({ workspaceId }, deps);
  else if (command === 'decide' && args.length === 0) outcome = decide(deps);
  else if (command === 'withdraw' && args.length === 1) outcome = withdraw(args[0], deps);
  else if (command === 'apply' && rest.length === 1) outcome = await apply(rest[0], { workspaceId }, deps);
  else if (command === 'request' && takeFlag(rest, '--args').value !== undefined && takeFlag(rest, '--args').rest.length === 1) {
    const { value: argsJson, rest: positional } = takeFlag(rest, '--args');
    outcome = await request(positional[0], { workspaceId: workspaceId ?? 'default', argsJson }, deps);
  }
  else {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  process.stdout.write(`${JSON.stringify(outcome.report, null, 2)}\n`);
  return outcome.code;
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }, (error) => {
    process.stderr.write(`huqan-authority: ${error.message}\n`);
    process.exitCode = 2;
  });
}

module.exports = { status, sync, decide, withdraw, apply, request, main };
