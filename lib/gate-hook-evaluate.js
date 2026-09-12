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
const { defaultExternalActionPolicyPath, readAllowedCommands } = require('./external-action-command-policy');
const {
  argumentValue,
  readJsonFile,
  readTrustedIdentityKeys,
  readStdin,
} = require('./gate-hook-input');

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
      // A policy file that cannot be read is a failure, not an empty list: the
      // catch below turns it into a fail-closed exit rather than a quiet allow.
      allowedCommands: readAllowedCommands(argumentValue('--policy') || defaultExternalActionPolicyPath(process.env, workspaceId)),
      workspaceRoot: argumentValue('--workspace-root') || undefined,
      workspaceId,
      agentName: argumentValue('--agent-name') || undefined,
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
    process.stdout.write(`${JSON.stringify(evaluated.projection.output)}\n`);
    process.exitCode = evaluated.projection.exitCode;
  } catch (error) {
    process.stderr.write(`HUQAN external action guard failed closed: ${error?.message || error}\n`);
    process.exitCode = 2;
  } finally {
    receiptWriter?.close?.();
  }
}

module.exports = { runHookEvaluation };
