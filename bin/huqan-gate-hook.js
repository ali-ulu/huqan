#!/usr/bin/env node
'use strict';

const {
  EXTERNAL_ADAPTER_PROFILES,
  evaluateHookInvocation,
} = require('../lib/external-action-adapter');
const { createDurableExternalActionReceiptWriter, defaultExternalActionReceiptPath } = require('../lib/external-action-receipt');
const { defaultExternalActionPolicyPath, readAllowedCommands } = require('../lib/external-action-command-policy');
const { manageGate, connectDetectedAgents } = require('../lib/external-action-gate-install');
const { queryIdentityLog } = require('../lib/gate-hook-identity');
const { runSealsCommand, runFleetCommand, runResidencyCommand } = require('../lib/gate-hook-reports');
const { buildAgentRoster } = require('../lib/external-action-agent-roster');
const { buildAgentOverview } = require('../lib/external-action-agent-overview');
const { writeCustomAgentAdapter } = require('../lib/external-action-adapter-generator');
const { createProcessFailureHandlers, failureCodeFor } = require('../lib/http/process-failure-handlers');
const { writeStructuredLog } = require('../lib/http/structured-log');
// Input parsing lives in lib/gate-hook-input.js (#2248); dispatch stays here.
const {
  argumentValue,
  readJsonFile,
  readSealKeyArgument,
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
    if (command === 'ship') {
      const { shipExternalActionReceipts } = require('../lib/external-action-receipt-shipper');
      // `--store` keeps a self-hosted deployment whole without HTTP: the same
      // batches, written straight into a collector store on disk or a share.
      const storeRoot = argumentValue('--store');
      // A local `--store` run checks the signature against the same trusted-key
      // directory an HTTP collector would use, so "does my signing key actually
      // verify" is answerable without standing up a server.
      const trustedKeysDir = argumentValue('--trusted-keys');
      const result = await shipExternalActionReceipts({
        ...(storeRoot ? {
          deliver: batch => {
            const collector = require('../lib/external-action-receipt-collector');
            return collector.ingestReceiptBatch({
              batch,
              root: storeRoot,
              trustedKeys: collector.readTrustedBatchKeys(trustedKeysDir),
              requireSignature: process.argv.includes('--require-signature'),
              // A store on a share the agent host cannot rewrite is the
              // self-hosted shape of a counter-seal, so `--store` seals too
              // when a key is named (#1882).
              sealKey: readSealKeyArgument(),
            });
          },
        } : {}),
        endpoint: argumentValue('--endpoint') || undefined,
        token: argumentValue('--token') || undefined,
        path: argumentValue('--receipt-log') || undefined,
        cursorPath: argumentValue('--cursor') || undefined,
        batchSize: argumentValue('--batch-size') || undefined,
        host: argumentValue('--host') || require('node:os').hostname(),
        signingKeyPath: argumentValue('--signing-key') || undefined,
        signingKeyId: argumentValue('--signing-key-id') || undefined,
        dryRun: process.argv.includes('--dry-run'),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      // A collector that would not take the evidence is a failure worth a
      // non-zero exit, so a scheduled run does not look successful in a log.
      process.exitCode = result.failure ? 1 : 0;
      return;
    }
    if (command === 'adapter') {
      // Generate the custom-agent adapter instead of describing it (#2061).
      const result = writeCustomAgentAdapter({
        root: argumentValue('--target-root') || process.cwd(),
        out: argumentValue('--out') || undefined,
        agentName: argumentValue('--agent-name') || undefined,
        force: process.argv.includes('--force'),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
      process.exitCode = 0;
      return;
    }
    if (command === 'overview') {
      // Connected agents and acting agents in one list -- what a monitoring
      // tab renders, including the connected-but-silent row (#2060).
      const overview = buildAgentOverview({
        root: argumentValue('--target-root') || process.cwd(),
        home: argumentValue('--home') || undefined,
        receiptPath: argumentValue('--receipt-log') || undefined,
        workspaceId: argumentValue('--workspace-id') || undefined,
      });
      process.stdout.write(`${JSON.stringify(overview, null, 2)}
`);
      process.exitCode = overview.ok ? 0 : 1;
      return;
    }
    if (command === 'agents') {
      // Which agents have acted at all -- the roster a monitoring view lists
      // (#2052). --identity-log answers the next question, per identity.
      const roster = buildAgentRoster(
        argumentValue('--receipt-log') || defaultExternalActionReceiptPath(),
        {
          workspaceId: argumentValue('--workspace-id') || undefined,
          since: argumentValue('--since') || undefined,
        },
      );
      process.stdout.write(`${JSON.stringify(roster, null, 2)}
`);
      process.exitCode = roster.ok ? 0 : 1;
      return;
    }
    if (command === 'connect') {
      // One command, no profile name: detect what is on the machine and
      // connect each one through the install that proves itself (#2050).
      const result = connectDetectedAgents({
        root: argumentValue('--target-root') || process.cwd(),
        home: argumentValue('--home') || undefined,
        receiptPath: argumentValue('--receipt-log') || undefined,
        detectOnly: process.argv.includes('--detect'),
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}
`);
      // Nothing connected is not success: a caller in a script must be able to
      // tell "protected" from "found nothing to protect".
      process.exitCode = result.connected > 0 || process.argv.includes('--detect') ? 0 : 1;
      return;
    }
    if (['install', 'uninstall', 'status'].includes(command)) {
      const result = manageGate(command, {
        deploymentAuthorized: true,
        profile: argumentValue('--profile') || undefined,
        root: argumentValue('--target-root') || process.cwd(),
        home: argumentValue('--home') || undefined,
        receiptPath: argumentValue('--receipt-log') || undefined,
        // Narrows the custom-agent observation to one agent name (#2048).
        agentName: argumentValue('--agent-name') || undefined,
      });
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 0;
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
