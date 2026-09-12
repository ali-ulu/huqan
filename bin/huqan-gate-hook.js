#!/usr/bin/env node
'use strict';

const {
  EXTERNAL_ADAPTER_PROFILES,
  evaluateHookInvocation,
} = require('../lib/external-action-adapter');
const { createDurableExternalActionReceiptWriter } = require('../lib/external-action-receipt');
const { defaultExternalActionPolicyPath, readAllowedCommands } = require('../lib/external-action-command-policy');
const { queryIdentityLog } = require('../lib/gate-hook-identity');
const { runSealsCommand, runFleetCommand, runResidencyCommand } = require('../lib/gate-hook-reports');
const {
  runShipCommand,
  runAdapterCommand,
  runOverviewCommand,
  runAgentsCommand,
  runConnectCommand,
  runGateCommand,
} = require('../lib/gate-hook-management');
const { createProcessFailureHandlers, failureCodeFor } = require('../lib/http/process-failure-handlers');
const { writeStructuredLog } = require('../lib/http/structured-log');
// Input parsing lives in lib/gate-hook-input.js (#2248); dispatch stays here.
const {
  argumentValue,
  readJsonFile,
  readTrustedIdentityKeys,
  readStdin,
} = require('../lib/gate-hook-input');

createProcessFailureHandlers({
  logError: (kind, cause) => writeStructuredLog(console, 'error', kind === 'uncaughtException' ? 'process.uncaught_exception' : 'process.unhandled_rejection', null, {
    runtime: 'gate-hook',
    errorCode: failureCodeFor(kind, cause),
  }),
}).bind();

// Input helpers live in lib/gate-hook-input.js, the identity reader in
// lib/gate-hook-identity.js (#2248).

async function main() {
  let receiptWriter;
  try {
    const command = process.argv[2];
    // Read-only report commands live in lib/gate-hook-reports.js (#2248).
    // `seals` asks the one question a stored receipt cannot answer for itself:
    // has anything been removed from this store since it was received. A break
    // exits non-zero, because a silent audit is not an audit (#1882).
    if (command === 'seals') {
      runSealsCommand();
      return;
    }
    if (command === 'fleet') {
      runFleetCommand();
      return;
    }
    // `residency` reads the trail this gate already wrote and reports the rule
    // its own decisions imply. It proposes and stops: applying it means editing
    // external-action-policy.json by hand, which is what keeps the resulting
    // boundary something a receipt can attest to (docs/what-huqan-learns.md).
    if (command === 'residency') {
      runResidencyCommand();
      return;
    }
    // Management commands live in lib/gate-hook-management.js (#2248).
    if (command === 'ship') {
      await runShipCommand();
      return;
    }
    if (command === 'adapter') {
      runAdapterCommand();
      return;
    }
    if (command === 'overview') {
      runOverviewCommand();
      return;
    }
    if (command === 'agents') {
      runAgentsCommand();
      return;
    }
    if (command === 'connect') {
      runConnectCommand();
      return;
    }
    if (['install', 'uninstall', 'status'].includes(command)) {
      runGateCommand(command);
      return;
    }
    if (argumentValue('--identity-log')) return queryIdentityLog();
    const profile = argumentValue('--profile', EXTERNAL_ADAPTER_PROFILES.GENERIC);
    const identityCardPath = argumentValue('--identity-card');
    const receiptPath = argumentValue('--receipt-log');
    const raw = await readStdin();
    const payload = JSON.parse(raw || '{}');
    if (command === 'browser-outcome' && !require('../lib/browser-hook-outcome').isBrowserTool(payload.tool_name)) {
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
      const { recordBrowserHookOutcome } = require('../lib/browser-hook-outcome');
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

main();
