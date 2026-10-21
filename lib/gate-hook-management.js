'use strict';

// Management commands for the huqan-gate-hook CLI entry point (#2248).
//
// Single responsibility: the mutating and roster commands -- ship, adapter,
// overview, agents, connect, install/uninstall/status, policy. Each marshals
// CLI arguments into its library call and prints JSON with the entry point's
// exact exit-code contract. Read-only reports live in
// lib/gate-hook-reports.js, hook evaluation stays in bin/huqan-gate-hook.js.
// This module never dispatches other commands.

const { argumentValue, readSealKeyArgument } = require('./gate-hook-input');
const { writeCustomAgentAdapter } = require('./external-action-adapter-generator');
const { buildAgentOverview } = require('./external-action-agent-overview');
const { buildAgentRoster } = require('./external-action-agent-roster');
const { connectDetectedAgents, manageGate } = require('./external-action-gate-install');
const { defaultExternalActionReceiptPath } = require('./external-action-receipt');
const { createCommandPolicyEditor } = require('./command-policy-editor');
const { listPolicyTemplates } = require('./command-policy-templates');
const { defaultExternalActionPolicyPath } = require('./external-action-command-policy');

/** A positional argument of the gate CLI, e.g. the template name. */
function positionalArgument(index) {
  const value = process.argv[index];
  return typeof value === 'string' ? value.trim() : '';
}

async function runShipCommand() {
  const { shipExternalActionReceipts } = require('./external-action-receipt-shipper');
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
        const collector = require('./external-action-receipt-collector');
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
}

function runAdapterCommand() {
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
}

function runOverviewCommand() {
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
}

function runAgentsCommand() {
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
}

function runConnectCommand() {
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
}

function runGateCommand(command) {
  const result = manageGate(command, {
    deploymentAuthorized: true,
    profile: argumentValue('--profile') || undefined,
    root: argumentValue('--target-root') || process.cwd(),
    home: argumentValue('--home') || undefined,
    receiptPath: argumentValue('--receipt-log') || undefined,
    // Narrows the custom-agent observation to one agent name (#2048).
    agentName: argumentValue('--agent-name') || undefined,
    // #2505: identity material bound to the recorded hook command, so a fresh
    // install can arm a card instead of blocking every call.
    identityCard: argumentValue('--identity-card') || undefined,
    identityCardSignature: argumentValue('--identity-card-signature') || undefined,
    trustedIdentityKeys: argumentValue('--trusted-identity-keys') || undefined,
  });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = 0;
}

/**
 * The built-in command policy templates (#4102).
 *
 * `policy list` names the templates; `policy apply <template>` writes one
 * into the deployment's own policy file. The file is the deployment's: the
 * operator chooses the path (`--policy`) and the template, and an existing
 * file is only replaced with an explicit `--force`, which backs it up first.
 * The HTTP editor route cannot reach any of this -- it has no way to name a
 * template or a file.
 */
function runPolicyCommand() {
  const subcommand = positionalArgument(3) || 'list';
  if (subcommand === 'list') {
    process.stdout.write(`${JSON.stringify({ templates: listPolicyTemplates() }, null, 2)}\n`);
    process.exitCode = 0;
    return;
  }
  if (subcommand !== 'apply') {
    process.stdout.write(`${JSON.stringify({ error: 'UNKNOWN_POLICY_COMMAND', subcommand })}\n`);
    process.exitCode = 2;
    return;
  }
  const template = positionalArgument(4);
  const target = argumentValue('--policy')
    || defaultExternalActionPolicyPath(process.env, argumentValue('--workspace-id', 'default'));
  const residency = argumentValue('--residency');
  try {
    const result = createCommandPolicyEditor(target).applyTemplate(template, {
      approved: process.argv.includes('--force'),
      residency: residency ? residency.split(',') : [],
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.requiresResidency && result.residency.length === 0) {
      process.stderr.write('HUQAN: this template expects a data residency declaration; without one the gate cannot refuse a transfer that leaves it.\n');
    }
    process.exitCode = 0;
  } catch (error) {
    let existing = null;
    try { existing = createCommandPolicyEditor(target).snapshot().allowedCommands; } catch (_) { existing = null; }
    process.stdout.write(`${JSON.stringify({
      error: error.code || 'POLICY_APPLY_FAILED',
      message: error.message,
      template,
      target,
      existingAllowedCommands: existing,
      hint: error.code === 'POLICY_EXISTS'
        ? 'the existing policy file was left untouched; rerun with --force to replace it, which writes a backup first'
        : null,
    }, null, 2)}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  runShipCommand,
  runAdapterCommand,
  runOverviewCommand,
  runAgentsCommand,
  runConnectCommand,
  runGateCommand,
  runPolicyCommand,
};
