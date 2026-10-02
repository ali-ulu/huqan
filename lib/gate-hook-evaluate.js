'use strict';

// Hook evaluation for the huqan-gate-hook CLI entry point (#2248, final slice).
//
// Single responsibility: the stdin -> payload -> verdict path. Reads the hook
// payload, short-circuits non-browser tools for browser-outcome, records the
// browser outcome or evaluates the invocation, and always closes the receipt
// writer. Fail-closed: any error exits 2, never a quiet allow. Command
// dispatch (reports, management, identity) lives in bin/huqan-gate-hook.js
// and the gate-hook-* modules; this module never dispatches other commands.

const {
  EXTERNAL_ADAPTER_PROFILES,
  evaluateHookInvocation,
} = require('./external-action-adapter');
const { createDurableExternalActionReceiptWriter } = require('./external-action-receipt');
const { createCommandShapeWriter } = require('./command-shape-log');
const { readReceiptHistory } = require('./autonomy-receipt-history');
const { readBypassState } = require('./bypass-signal-state');
const { evaluateBypassResponse, recommendationsForBypass } = require('./bypass-response');
const { recordRetriedRefusalSignals } = require('./session-impact');
const {
  defaultExternalActionPolicyPath,
  readAllowedCommands,
  readBypassResponsePolicy,
} = require('./external-action-command-policy');
const {
  argumentValue,
  readJsonFile,
  readTrustedIdentityKeys,
  readStdin,
} = require('./gate-hook-input');

function bypassAdviceFor(evaluated, receiptWriter, workspaceId, policyPath) {
  if (!evaluated?.result?.receiptPersisted || !receiptWriter?.graph) return null;

  // The current rejection is durable before this read. Re-scanning the bounded
  // receipt history is safe because receipt-backed bypass signals are
  // idempotent; on the second identical refusal both verified receipts become
  // evidence, which is what makes a reviewAfter: 2 policy observable.
  const receipts = readReceiptHistory({ path: receiptWriter.path });
  recordRetriedRefusalSignals(
    receipts,
    evaluated.result.envelope?.session?.id,
    receiptWriter.graph,
  );

  const policy = readBypassResponsePolicy(policyPath);
  if (!policy) return null;
  const agentId = evaluated.result.envelope?.identity?.identityRef || null;
  const state = readBypassState(receiptWriter.graph, { workspaceId, agentId });
  const evaluation = evaluateBypassResponse(state, policy);
  const recommendations = recommendationsForBypass(evaluation, { workspaceId, agentId })
    .map((entry) => Object.freeze({
      ...entry,
      recommendation: entry.decision === 'block' ? 'block recommended' : 'review recommended',
    }));
  return Object.freeze({
    adviceOnly: true,
    recommendations: Object.freeze(recommendations),
  });
}

async function runHookEvaluation(command) {
  let receiptWriter;
  try {
    const profile = argumentValue('--profile', EXTERNAL_ADAPTER_PROFILES.GENERIC);
    const identityCardPath = argumentValue('--identity-card');
    const receiptPath = argumentValue('--receipt-log');
    const raw = await readStdin();
    const payload = JSON.parse(raw || '{}');
    if (command === 'browser-outcome' && !require('./browser-hook-outcome').isBrowserTool(payload.tool_name)) {
      process.stdout.write('{}\n');
      process.exitCode = 0;
      return;
    }
    receiptWriter = createDurableExternalActionReceiptWriter({
      ...(receiptPath ? { path: receiptPath } : {}),
      memoryPath: argumentValue('--memory-path') || undefined,
      dbPath: argumentValue('--db-path') || undefined,
    });
    const workspaceId = argumentValue('--workspace-id', 'default');
    const policyPath = argumentValue('--policy') || defaultExternalActionPolicyPath(process.env, workspaceId);
    if (command === 'browser-outcome') {
      const { recordBrowserHookOutcome } = require('./browser-hook-outcome');
      recordBrowserHookOutcome(profile, payload, {
        receiptWriter, workspaceId,
        workspaceRoot: argumentValue('--workspace-root') || undefined,
        // #2141: page preview is written only when the deployment explicitly
        // consents, e.g. `--page-preview text,screenshot`. The hook payload
        // itself can never turn this on.
        pagePreview: argumentValue('--page-preview') || undefined,
      });
      process.stdout.write('{}\n');
      process.exitCode = 0;
      return;
    }
    const evaluated = evaluateHookInvocation(profile, payload, {
      receiptWriter,
      // Beside the trail, never inside it: which command a reviewed action
      // was, for `huqan-gate command-proposals` to learn from (#3025).
      commandShapeWriter: createCommandShapeWriter(receiptWriter.path),
      // A policy file that cannot be read is a failure, not an empty list: the
      // catch below turns it into a fail-closed exit rather than a quiet allow.
      allowedCommands: readAllowedCommands(policyPath),
      workspaceRoot: argumentValue('--workspace-root') || undefined,
      workspaceId,
      agentName: argumentValue('--agent-name') || undefined,
      // #2505 C: the run this invocation belongs to, for task-scoped cards.
      // Absent by default: unscoped cards evaluate exactly as before, and a
      // task-bound card with no task in context fails closed downstream.
      taskId: argumentValue('--task-id') || undefined,
      identityCard: identityCardPath ? readJsonFile(identityCardPath) : undefined,
      identityCardSignature: argumentValue('--identity-card-signature')
        ? readJsonFile(argumentValue('--identity-card-signature'))
        : undefined,
      trustedPublicKeys: argumentValue('--trusted-identity-keys')
        ? readTrustedIdentityKeys(argumentValue('--trusted-identity-keys'))
        : undefined,
      requireIdentityCard: process.argv.includes('--require-identity') ? true : undefined,
      requireSignedIdentityCard: process.argv.includes('--require-signed-identity') ? true : undefined,
      allowControlPlane: process.argv.includes('--allow-control-plane') ? true : undefined,
      graduatedAutonomy: process.argv.includes('--graduated-autonomy') ? {
        enabled: true,
        receiptPath: receiptWriter.path,
        ...(argumentValue('--autonomy-activation') ? {
          activation: {
            status: 'approved',
            approvalId: argumentValue('--autonomy-activation'),
            actor: argumentValue('--human-approver'),
            actorType: 'human',
            approvedAt: argumentValue('--approved-at'),
          },
        } : {}),
      } : undefined,
    });
    if (evaluated.result.commandShapeError) {
      process.stderr.write(`HUQAN command shape log not written: ${evaluated.result.commandShapeError}\n`);
    }

    // #3338: bypass response is decision support only. Its state is produced
    // after the admission receipt is durable, and any failure here is surfaced
    // without changing the gate verdict or exit code.
    let bypassAdvice = null;
    try {
      bypassAdvice = bypassAdviceFor(evaluated, receiptWriter, workspaceId, policyPath);
    } catch (error) {
      process.stderr.write(`HUQAN bypass advice unavailable: ${error?.message || error}\n`);
    }
    const output = profile === EXTERNAL_ADAPTER_PROFILES.GENERIC && bypassAdvice
      ? { ...evaluated.projection.output, bypassAdvice }
      : evaluated.projection.output;
    process.stdout.write(`${JSON.stringify(output)}\n`);
    process.exitCode = evaluated.projection.exitCode;
  } catch (error) {
    process.stderr.write(`HUQAN external action guard failed closed: ${error?.message || error}\n`);
    process.exitCode = 2;
  } finally {
    receiptWriter?.close?.();
  }
}

module.exports = { runHookEvaluation, bypassAdviceFor };
