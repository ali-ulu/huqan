#!/usr/bin/env node
'use strict';

/**
 * huqan-authority (#3860, ADR-016): the runtime's side of the approval
 * authority.
 *
 *   huqan-authority status                  which authority this runtime answers to,
 *                                           and whether the pinned service answers
 *   huqan-authority sync [--workspace <id>] register pending local approvals with it
 *   huqan-authority apply <approvalId> [--workspace <id>]
 *                                           fetch the operator's signed decision,
 *                                           consume it, carry it out, record the outcome
 *
 * Exit 0 on success. Exit 2 when an authority is required or installed but
 * cannot be used, answers as something other than the pinned service, or
 * refuses. Exit 3 when the approval is still waiting for the operator.
 */

const crypto = require('node:crypto');
const { resolveApprovalAuthorityMode } = require('../lib/authority/authority-mode');
const { createAuthorityClient } = require('../lib/authority/authority-client');
const { buildRegistration, consumeProofFor, storedArgumentsOf } = require('../lib/authority/registration-payload');
const { loadOrCreateConsumeKey } = require('../lib/authority/consume-key');
const { listPersistentApprovals, formatApprovalRecord } = require('../lib/mcp-approval-views');
const { requireAuthorityDecision } = require('../lib/authority/decision-guard');
const { resolveMcpApprovalTtlMs } = require('../lib/mcp-approval-expiry');

const USAGE = 'usage: huqan-authority status | sync [--workspace <id>] | apply <approvalId> [--workspace <id>]';
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

function defaults(deps) {
  return { resolveMode: resolveApprovalAuthorityMode, createClient: createAuthorityClient, openRuntime: openLocalRuntime,
    loadConsumeKey: loadOrCreateConsumeKey, ttlMs: () => resolveMcpApprovalTtlMs(), ...deps };
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

async function apply(approvalId, { workspaceId = 'default' } = {}, deps = {}) {
  const { resolveMode, createClient, openRuntime, loadConsumeKey } = defaults(deps);
  const mode = resolveMode();
  const refusal = serviceOrRefusal(mode);
  if (refusal) return refusal;
  const client = createClient({ pin: mode.pin });
  const fetched = await client.getDecision(approvalId);
  if (fetched.status !== 200) return { code: 2, report: { approvalId, error: fetched.body?.code || `HTTP_${fetched.status}` } };
  if (!fetched.body.envelope) return { code: 3, report: { approvalId, status: 'pending', next: 'decide it in the HUQAN Authority window' } };
  const envelope = fetched.body.envelope;
  const decision = envelope.payload.decision;
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

function parseWorkspace(args) {
  const i = args.indexOf('--workspace');
  return i >= 0 ? { workspaceId: args[i + 1], rest: args.filter((_, j) => j !== i && j !== i + 1) } : { rest: args };
}

async function main(argv = process.argv.slice(2), deps = {}) {
  const [command, ...args] = argv;
  const { workspaceId, rest } = parseWorkspace(args);
  let outcome;
  if (command === 'status' && args.length === 0) outcome = await status(deps);
  else if (command === 'sync' && rest.length === 0) outcome = await sync({ workspaceId }, deps);
  else if (command === 'apply' && rest.length === 1) outcome = await apply(rest[0], { workspaceId }, deps);
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

module.exports = { status, sync, apply, main };
