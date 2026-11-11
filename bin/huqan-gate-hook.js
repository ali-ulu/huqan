#!/usr/bin/env node
'use strict';

// #4551: same fail-closed runtime gate as cli.js and mcpServer.js (#4532).
// This runs before ANY other require: the hook path reaches the native SQLite
// binding through the receipt writer's Graph, so an unsupported runtime must
// stop here with a readable error instead of a silent SIGSEGV.
require('../lib/node-runtime-guard').assertSupportedNodeRuntime();

// Hot-path requires only. A PreToolUse call runs the hook evaluation and
// nothing else, but the entry point used to load every dispatch surface
// (reports, management, identity, break-glass) up front: that was the bulk of
// a call's wall time, for modules a PreToolUse call never reached. Each command
// now requires its own module where it is dispatched. The static require walk
// in lib/module-reachability.js still sees every literal below, so the recorded
// dependency graph is unchanged.
const { createProcessFailureHandlers, failureCodeFor } = require('../lib/http/process-failure-handlers');
const { writeStructuredLog } = require('../lib/http/structured-log');
// Input parsing lives in lib/gate-hook-input.js, hook evaluation in
// lib/gate-hook-evaluate.js (#2248); dispatch stays here. The evaluation module
// is required only on the one-shot fallback path below, so a call that the
// daemon answers never pays for loading it.
const { argumentValue } = require('../lib/gate-hook-input');

// The per-invocation hook context (AURA signal provider, approval-authority
// verifier) is built in lib/gate-hook-context.js so the daemon builds exactly
// the same one. See that module for the #3843 / #3892 boundary notes. It is
// required lazily, on the one-shot fallback only: a call the daemon answers
// never needs it, and loading it up front would cost the client more than the
// daemon saves.
const { isDaemonEnabled } = require('../lib/gate-hook-daemon');

createProcessFailureHandlers({
  logError: (kind, cause) => writeStructuredLog(console, 'error', kind === 'uncaughtException' ? 'process.uncaught_exception' : 'process.unhandled_rejection', null, {
    runtime: 'gate-hook',
    errorCode: failureCodeFor(kind, cause),
  }),
}).bind();

/**
 * Run the hook evaluation for this invocation, preferring the daemon.
 *
 * The daemon serves exactly the calls that reach `runHookEvaluation`: a
 * `PreToolUse` call (whose first argument is `--profile`, not a verb) and
 * `browser-outcome`. Report, management, identity and break-glass commands are
 * dispatched above and never come here.
 *
 * stdin is read once and buffered: the daemon needs the payload, and a
 * fallback to the one-shot path must see the same bytes rather than an already
 * drained stream. A daemon that is missing, refuses to connect or is disabled
 * costs latency only -- the one-shot path then runs unchanged, so a decision is
 * never lost to the daemon.
 */
async function evaluate(command) {
  const { readStdin } = require('../lib/gate-hook-input');
  const stdin = await readStdin();

  if (isDaemonEnabled() && !process.argv.includes('--no-daemon')) {
    const daemon = require('../lib/gate-hook-daemon');
    try {
      const response = await daemon.requestDaemon({ argv: process.argv, stdin });
      if (response.stdout) process.stdout.write(response.stdout);
      if (response.stderr) process.stderr.write(response.stderr);
      process.exitCode = response.exitCode;
      return;
    } catch (error) {
      // "No daemon" (not running, refused, timed out before send) falls back.
      // A failure *after* the request was sent is reported and stays failed
      // closed: re-running the action would write a second receipt for one
      // action, and could turn a refusal into an allow.
      if (/after send/.test(String(error?.message))) {
        process.stderr.write(`HUQAN external action guard failed closed: ${error.message}\n`);
        process.exitCode = 2;
        return;
      }
      writeStructuredLog(console, 'debug', 'gate_hook.daemon_unavailable', null, {
        runtime: 'gate-hook', error: error && error.message,
      });
    }
  }

  const { runHookEvaluation } = require('../lib/gate-hook-evaluate');
  const { runWithInvocation } = require('../lib/gate-hook-input');
  const { hookContextFor } = require('../lib/gate-hook-context');
  await runWithInvocation({ argv: process.argv, stdin }, () => runHookEvaluation(command, hookContextFor(process.argv)));
}

// Input helpers live in lib/gate-hook-input.js, the identity reader in
// lib/gate-hook-identity.js (#2248).

async function main() {
  try {
    const command = process.argv[2];
    // `daemon` (perf): start/stop/status of the long-lived gate. Opt-in: a
    // deployment that never runs it keeps the one-shot path exactly as before.
    if (command === 'daemon') {
      const daemon = require('../lib/gate-hook-daemon');
      const verb = process.argv[3];
      if (verb === 'serve') { daemon.runDaemonServer(); return; }
      if (verb === 'start') {
        const result = daemon.startDaemon();
        process.stdout.write(`${JSON.stringify(result)}\n`);
        if (!result.started && !result.alreadyRunning) process.exitCode = 1;
        return;
      }
      if (verb === 'stop') {
        process.stdout.write(`${JSON.stringify(daemon.stopDaemon())}\n`);
        return;
      }
      // Default/`status`: report whether a daemon answers, without starting one.
      process.stdout.write(`${JSON.stringify(daemon.daemonStatus())}\n`);
      return;
    }
    // Read-only report commands live in lib/gate-hook-reports.js (#2248).
    // `seals` asks the one question a stored receipt cannot answer for itself:
    // has anything been removed from this store since it was received. A break
    // exits non-zero, because a silent audit is not an audit (#1882).
    if (command === 'seals') {
      require('../lib/gate-hook-reports').runSealsCommand();
      return;
    }
    if (command === 'fleet') {
      require('../lib/gate-hook-reports').runFleetCommand();
      return;
    }
    // `residency` reads the trail this gate already wrote and reports the rule
    // its own decisions imply. It proposes and stops: applying it means editing
    // external-action-policy.json by hand, which is what keeps the resulting
    // boundary something a receipt can attest to (docs/what-huqan-learns.md).
    if (command === 'residency') {
      require('../lib/gate-hook-reports').runResidencyCommand();
      return;
    }
    // `command-proposals` is the same shape pointed the other way: the commands
    // a person keeps approving, proposed as allowedCommands and never applied.
    if (command === 'command-proposals') {
      require('../lib/gate-hook-reports').runCommandProposalsCommand();
      return;
    }
    // Management commands live in lib/gate-hook-management.js (#2248).
    if (command === 'ship') {
      await require('../lib/gate-hook-management').runShipCommand();
      return;
    }
    // `siem-export` moves the guard's decisions into the deployment's own SIEM
    // (#4093). Separate from the hook path on purpose: a collector or a SIEM
    // being down must never be able to change what an agent may do. The
    // marshal is required here rather than in lib/gate-hook-management.js,
    // because the export is an Adapter and Core may not require one.
    if (command === 'siem-export') {
      // SIEM export is an Enterprise feature (LICENSE-ENTERPRISE); a core-only
      // install says so instead of failing on a missing module.
      const { enterpriseMissingMessage, loadEnterpriseModule } = require('../lib/enterprise-module');
      const siem = loadEnterpriseModule('./siem/siem-export-command');
      if (!siem) throw new Error(enterpriseMissingMessage('SIEM export'));
      await siem.runSiemExportCommand();
      return;
    }
    if (command === 'adapter') {
      require('../lib/gate-hook-management').runAdapterCommand();
      return;
    }
    if (command === 'overview') {
      require('../lib/gate-hook-management').runOverviewCommand();
      return;
    }
    if (command === 'agents') {
      require('../lib/gate-hook-management').runAgentsCommand();
      return;
    }
    if (command === 'connect') {
      require('../lib/gate-hook-management').runConnectCommand();
      return;
    }
    if (command === 'browser-session') {
      const { runBrowserSessionCommand } = require('../lib/browser-session-observer');
      await runBrowserSessionCommand();
      return;
    }
    // `canary` issues a context canary to plant in a prompt, document or
    // memory entry; AB14 blocks any action that carries it. Nothing is stored:
    // the id verifies itself, and the fingerprint is what receipts will name.
    if (command === 'canary') {
      const { issueContextCanary } = require('../lib/context-canary');
      process.stdout.write(`${JSON.stringify(issueContextCanary())}\n`);
      return;
    }
    if (['install', 'uninstall', 'status'].includes(command)) {
      require('../lib/gate-hook-management').runGateCommand(command);
      return;
    }
    // `policy` applies one of the built-in command policy templates (#4102) to
    // the deployment's own policy file. It never runs an action.
    if (command === 'policy') {
      require('../lib/gate-hook-management').runPolicyCommand();
      return;
    }
    // `break-glass` (İP-2) is the operator surface for time-boxed override
    // windows: status/issue/lift. Issuing is a terminal act; the hook path only
    // reads a window whose id an operator issued. The operator credential lives
    // here, at the composition root (Platform), and is passed into the
    // AgentAction module as a seam: that module may not import this entrypoint,
    // and without the seam `issue`/`lift` refuse fail-closed.
    if (command === 'break-glass') {
      const { requireOperatorPresence } = require('../lib/cli-operator-presence');
      await require('../lib/gate-hook-break-glass').runBreakGlassCommand({
        authorize: (spec, act) => requireOperatorPresence(spec, {}, act),
      });
      return;
    }
    if (argumentValue('--identity-log')) {
      require('../lib/gate-hook-identity').queryIdentityLog();
      return;
    }
    // `identity issue` mints the capability card a gate call needs; without it
    // the only issuance path was hand-written JSON (#2505).
    if (command === 'identity') {
      require('../lib/external-action-identity-issue').issueIdentityCard();
      return;
    }
    await evaluate(command);
  } catch (error) {
    process.stderr.write(`HUQAN external action guard failed closed: ${error?.message || error}\n`);
    process.exitCode = 2;
  }
}

main();
