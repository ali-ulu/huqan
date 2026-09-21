'use strict';

const { CLI_COMMAND_CAPABILITIES } = require('./workflow-contract');
const { runIngestBatch } = require('./cli-ingest-batch');
const { formatCliGateMessage } = require('./cli-gate-message');
const { CLI_EXIT_CODES, statusFromResult, cliEnvelope, jsonError } = require('./cli-workflow-envelope');
const { ingestPreviewResult, formatIngestPreview, ingestPreviewArgv } = require('./cli-ingest-preview');
const { readCompatibleEnvironmentVariable } = require('./environment-compat');

const workflowByCommand = new Map(CLI_COMMAND_CAPABILITIES.map(item => [item.command, item.workflowId]));

function workflowIdForCommand(command) {
  return workflowByCommand.get(String(command || '')) || null;
}

function splitJsonFlag(argv) {
  const args = Array.from(argv || [], value => String(value));
  const json = args.includes('--json');
  return { json, args: args.filter(value => value !== '--json') };
}

async function runCliArgv(argv = [], io = {}, deps = {}) {
  const parsedFlags = splitJsonFlag(argv);
  const args = parsedFlags.args;
  const stdout = typeof io.stdout === 'function' ? io.stdout : console.log;
  const stderr = typeof io.stderr === 'function' ? io.stderr : console.error;
  const write = value => stdout(parsedFlags.json ? JSON.stringify(value) : value);

  if (args.length === 0) {
    if (parsedFlags.json) write(jsonError(null, 'failed', 'INVALID_INPUT', 'A command is required.'));
    return { interactive: !parsedFlags.json, exitCode: parsedFlags.json ? 2 : 0 };
  }
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    const cli = io.cli || deps.createCli({ kernel: { noLoad: true, loadPlugins: false } });
    write(parsedFlags.json ? cliEnvelope('cli-help', { output: cli.execute('yardım', '') }) : cli.execute('yardım', ''));
    return { interactive: false, exitCode: 0, workflowId: 'cli-help' };
  }
  if (args.length === 1 && ['--version', '-v'].includes(args[0])) {
    write(parsedFlags.json ? cliEnvelope('cli-version', { version: deps.version }) : deps.version);
    return { interactive: false, exitCode: 0, workflowId: 'cli-version' };
  }
  if (args[0].startsWith('-')) {
    const message = `Unknown option: ${args[0]}`;
    if (parsedFlags.json) write(jsonError(null, 'failed', 'INVALID_INPUT', message)); else stderr(message);
    return { interactive: false, exitCode: 2 };
  }

  if (args[0] === 'ingest' && args[1] === 'preview') {
    const workflowId = workflowIdForCommand('ingest-preview');
    const result = ingestPreviewResult(ingestPreviewArgv(args));
    if (parsedFlags.json) {
      write(result.error
        ? jsonError(workflowId, result.status, result.error.code, result.error.message)
        : cliEnvelope(workflowId, result, result.status));
    } else {
      (result.error ? stderr : stdout)(formatIngestPreview(result));
    }
    return {
      interactive: false,
      exitCode: CLI_EXIT_CODES[result.status],
      command: 'ingest-preview',
      workflowId,
    };
  }

  if (args[0] === 'stop' || args[0] === 'lift') {
    // #2505 F: the operator emergency stop, handled before the interactive
    // parser like `ingest batch`. The ledger writes the record and its receipt.
    const action = args[0];
    const workflowId = workflowIdForCommand(action);
    const flag = (name) => {
      const index = args.indexOf(`--${name}`);
      return index >= 0 ? String(args[index + 1] || '') : '';
    };
    const target = { scope: flag('scope'), workspaceId: flag('workspace') || 'default', agentId: flag('agent') || undefined };
    try {
      const { emergencyStopLedger } = require('./emergency-stop');
      const ledger = emergencyStopLedger({ emergencyStop: deps.emergencyStop });
      const result = ledger[action]({ ...target, reason: flag('reason'), actor: 'operator:cli' });
      const done = action === 'stop' ? (result.created ? 'Stopped' : 'Already stopped') : (result.lifted ? 'Lifted' : 'Not stopped');
      if (parsedFlags.json) write(cliEnvelope(workflowId, { data: result }, 'completed'));
      else stdout(`${done}: ${target.scope} ${target.workspaceId}${target.agentId ? ` ${target.agentId}` : ''}`);
      return { interactive: false, exitCode: CLI_EXIT_CODES.completed, command: action, workflowId };
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      if (parsedFlags.json) write(jsonError(workflowId, 'invalid_input', 'INVALID_INPUT', error.message)); else stderr(error.message);
      return { interactive: false, exitCode: CLI_EXIT_CODES.invalid_input, command: action, workflowId };
    }
  }

  if (args[0] === 'integrity') {
    // #2591: read-only integrity check over the emergency-stop ledger, with an
    // explicit siren. verifyIntegrity() + listIntegrityViolations() never
    // notify by themselves; --notify sounds the siren once per violation entry
    // via the webhook adapter. There is deliberately no --mute flag.
    const workflowId = workflowIdForCommand('integrity');
    const flag = (name) => {
      const index = args.indexOf(`--${name}`);
      return index >= 0 ? String(args[index + 1] || '') : '';
    };
    const wantNotify = args.includes('--notify');
    try {
      const { emergencyStopLedger } = require('./emergency-stop');
      const ledger = emergencyStopLedger({ emergencyStop: deps.emergencyStop });
      const integrity = ledger.verifyIntegrity();
      const violations = ledger.listIntegrityViolations();
      const summary = {
        ok: integrity.ok,
        reason: integrity.reason,
        details: integrity.details,
        violations,
      };
      if (!wantNotify) {
        if (parsedFlags.json) write(cliEnvelope(workflowId, { data: summary }, 'completed'));
        else if (!integrity.ok) stdout(`INTEGRITY VIOLATION: ${integrity.details?.ledgerReason || integrity.reason} (${violations.length} recorded)`);
        else stdout(violations.length ? `Ledger verifies, ${violations.length} past violation(s) on record.` : 'Ledger verifies, no violations on record.');
        return { interactive: false, exitCode: CLI_EXIT_CODES.completed, command: 'integrity', workflowId };
      }
      const url = readCompatibleEnvironmentVariable('NOTIFY_WEBHOOK_URL') || '';
      const secret = readCompatibleEnvironmentVariable('NOTIFY_WEBHOOK_SECRET') || '';
      if (!url || !secret) {
        const message = 'Refusing to notify silently: set HUQAN_NOTIFY_WEBHOOK_URL and HUQAN_NOTIFY_WEBHOOK_SECRET.';
        if (parsedFlags.json) write(jsonError(workflowId, 'invalid_input', 'INVALID_INPUT', message)); else stderr(message);
        return { interactive: false, exitCode: CLI_EXIT_CODES.invalid_input, command: 'integrity', workflowId };
      }
      const { createWebhookNotificationAdapter, notifySafely } = require('./observability/notification-adapter');
      const { notifyIntegrityViolations } = require('./integrity-violation-notifier');
      const adapter = createWebhookNotificationAdapter({ url, secret });
      const result = await notifyIntegrityViolations({ emergencyStop: ledger, notify: (input) => notifySafely(adapter, input) });
      const status = result.ok ? 'completed' : 'failed';
      if (parsedFlags.json) write(cliEnvelope(workflowId, { data: { ...summary, notify: result } }, status));
      else if (!result.ok) stderr(`Siren failed: ${result.failures.map((failure) => `${failure.seq}:${failure.reason}`).join(', ') || 'no adapter'}`);
      else stdout(`Siren sounded for ${result.notified} violation(s).`);
      return { interactive: false, exitCode: CLI_EXIT_CODES[status], command: 'integrity', workflowId };
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      if (parsedFlags.json) write(jsonError(workflowId, 'invalid_input', 'INVALID_INPUT', error.message)); else stderr(error.message);
      return { interactive: false, exitCode: CLI_EXIT_CODES.invalid_input, command: 'integrity', workflowId };
    }
  }

  if (args[0] === 'ingest' && args[1] === 'batch') {
    const action = String(args[2] || '').toLowerCase();
    const workflowId = action === 'preview' ? 'ingest-preview'
      : action === 'status' ? 'ingest-run-detail' : 'ingest-execute';
    try {
      const result = await runIngestBatch(args, deps);
      const envelope = cliEnvelope(workflowId, { data: result }, result.status);
      write(envelope);
      return { interactive: false, exitCode: CLI_EXIT_CODES[result.status] ?? CLI_EXIT_CODES.failed, command: `ingest-batch-${action}`, workflowId };
    } catch (error) {
      const status = 'invalid_input';
      write(jsonError(workflowId, status, error?.code || 'INVALID_BATCH', error?.message || String(error)));
      return { interactive: false, exitCode: CLI_EXIT_CODES[status], command: `ingest-batch-${action}`, workflowId };
    }
  }

  const cli = io.cli || deps.createCli();
  let workflowId = null;
  try {
    if (!io.cli && cli.kernel && typeof cli.kernel.reload === 'function') cli.kernel.reload();
    const parsed = cli.parse(args.join(' '));
    workflowId = parsed?.workflowId || workflowIdForCommand(parsed?.command);
    if (!parsed || parsed.command === 'anlamadım' || parsed.command === 'exit') {
      const message = `Unknown command: ${args.join(' ')}`;
      if (parsedFlags.json) write(jsonError(workflowId, 'failed', 'INVALID_INPUT', message)); else stderr(message);
      return { interactive: false, exitCode: 2, workflowId };
    }
    if (parsedFlags.json && !workflowId) {
      write(jsonError(null, 'capability_not_available', 'UNSUPPORTED_WORKFLOW', 'This command has no enabled CLI workflow contract.'));
      return { interactive: false, exitCode: CLI_EXIT_CODES.capability_not_available, command: parsed.command };
    }

    const gateResult = cli.evaluateCliGate(parsed.command, parsed.args);
    if (gateResult && !gateResult.canExecute) {
      const status = gateResult.decision === 'review' ? 'review_required' : 'blocked';
      const learnProposal = status === 'review_required' && workflowId === 'learn-review'
        && typeof cli.queueLearnReview === 'function'
        ? await cli.queueLearnReview(parsed.args)
        : null;
      if (parsedFlags.json) {
        write(cliEnvelope(workflowId, learnProposal || { data: { gate: gateResult } }, status));
      } else if (learnProposal?.approval?.id) {
        stdout(`Learn requires review. Approval queued: ${learnProposal.approval.id}`);
      } else {
        stdout(formatCliGateMessage(parsed.command, gateResult));
      }
      return {
        interactive: false,
        exitCode: CLI_EXIT_CODES[status],
        command: parsed.command,
        workflowId,
        decision: gateResult.decision,
      };
    }

    const output = await cli.execute(parsed.command, parsed.args, {
      gateResult,
      throwOnError: true,
      json: parsedFlags.json,
    });
    if (parsed.command === 'doctor') {
      if (parsedFlags.json) stdout(JSON.stringify({ ok: output?.ok === true, checks: output?.checks || {} }));
      else stdout(output?.text || String(output || ''));
      return {
        interactive: false,
        exitCode: output?.ok === true ? 0 : 1,
        command: parsed.command,
        workflowId,
      };
    }
    const status = statusFromResult(output);
    write(parsedFlags.json ? cliEnvelope(workflowId, output, status) : (typeof output === 'string' ? output : JSON.stringify(output)));
    return {
      interactive: false,
      exitCode: CLI_EXIT_CODES[status] ?? CLI_EXIT_CODES.failed,
      command: parsed.command,
      workflowId,
    };
  } catch (error) {
    const message = `Command error: ${error?.message || error}`;
    const unauthorized = error?.code === 'OPERATOR_AUTH_REQUIRED' || error?.exitCode === 4;
    const status = unauthorized ? 'unauthorized' : 'failed';
    if (parsedFlags.json) write(jsonError(workflowId, status, error?.code || 'COMMAND_FAILED', message, error?.meta)); else stderr(message);
    // An error that carries its own code keeps it -- `onayla` raises
    // invalid_input (cli.js) and that is more precise than 'failed'. The bug
    // was that --json discarded it and reported 8; parity resolves toward the
    // specific code, in both modes, not away from it.
    return { interactive: false, exitCode: error?.exitCode ?? CLI_EXIT_CODES[status], workflowId };
  }
}

module.exports = { CLI_EXIT_CODES, workflowIdForCommand, splitJsonFlag, cliEnvelope, runCliArgv };
