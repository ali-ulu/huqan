'use strict';

const { workflowEnvelope } = require('./http/workflow-envelope');
const { WORKFLOW_STATUSES, CLI_COMMAND_CAPABILITIES } = require('./workflow-contract');
const { buildIngestWorkflowPreview } = require('./ingest-workflow-preview');
const { runIngestBatch } = require('./cli-ingest-batch');

const CLI_EXIT_CODES = Object.freeze({
  completed: 0,
  invalid_input: 2,
  capability_not_available: 3,
  unauthorized: 4,
  queued: 5,
  review_required: 5,
  blocked: 6,
  paused: 7,
  partial: 7,
  failed: 8,
});

const workflowByCommand = new Map(CLI_COMMAND_CAPABILITIES.map(item => [item.command, item.workflowId]));

function workflowIdForCommand(command) {
  return workflowByCommand.get(String(command || '')) || null;
}

function splitJsonFlag(argv) {
  const args = Array.from(argv || [], value => String(value));
  const json = args.includes('--json');
  return { json, args: args.filter(value => value !== '--json') };
}

function statusFromResult(result) {
  const candidate = result?.status || result?.data?.status;
  if (WORKFLOW_STATUSES.includes(candidate)) return candidate;
  if (candidate === 'review') return 'review_required';
  return result && typeof result === 'object' && result.ok === false ? 'failed' : 'completed';
}

function cliEnvelope(workflowId, result, status = statusFromResult(result), error = null) {
  const payload = result?.data ?? result;
  const boundedMeta = {};
  const identity = result?.meta?.identity ?? error?.meta?.identity;
  const oversight = result?.meta?.oversight ?? error?.meta?.oversight;
  if (identity && typeof identity === 'object') boundedMeta.identity = identity;
  if (oversight && typeof oversight === 'object') boundedMeta.oversight = oversight;
  const base = workflowEnvelope({
    ok: status === 'completed',
    status,
    data: error ? null : (payload && typeof payload === 'object' ? payload : { output: payload }),
    error,
    evidence: result?.evidence,
    confidence: result?.confidence ?? result?.data?.confidence,
    receiptId: result?.receiptId ?? result?.data?.receiptId ?? result?.data?.receipt?.receiptId,
  });
  return {
    ...base,
    workflowId,
    approval: result?.approval ?? result?.data?.approval ?? null,
    ...(Object.keys(boundedMeta).length > 0 ? { meta: boundedMeta } : {}),
    trace: {
      traceId: base.traceId,
      runId: result?.data?.runId ?? result?.runId ?? null,
      checkpointId: result?.data?.checkpointId ?? result?.checkpointId ?? null,
      resumeToken: result?.data?.resumeToken ?? result?.resumeToken ?? null,
      resumed: result?.data?.resumed === true || result?.resumed === true,
      resumedFrom: result?.data?.resumedFrom ?? result?.resumedFrom ?? null,
      nextAction: result?.data?.nextAction ?? result?.nextAction ?? null,
    },
  };
}

function jsonError(workflowId, status, code, message, meta = null) {
  return cliEnvelope(workflowId, null, status, {
    code,
    message,
    ...(meta && typeof meta === 'object' ? { meta } : {}),
  });
}

function ingestPreviewResult(input) {
  if (input?.sourceType !== 'manual') {
    return {
      status: 'capability_not_available',
      error: { code: 'INGEST_SOURCE_UNSUPPORTED', message: 'CLI preview supports manual sources only.' },
    };
  }
  if (!input.sourceRef || !input.text) {
    return {
      status: 'invalid_input',
      error: { code: 'INVALID_INGEST', message: 'Manual preview requires --ref and quoted text.' },
    };
  }
  const preview = buildIngestWorkflowPreview({ ...input, title: input.sourceRef, author: 'cli-user' });
  if (!preview.ok) {
    return { status: 'invalid_input', error: { code: preview.code, message: preview.error } };
  }
  return {
    status: 'review_required',
    data: {
      sourceManifest: preview.sourceManifest,
      progress: preview.progress,
      review: preview.review,
      nextAction: preview.review.nextAction,
    },
  };
}

function formatIngestPreview(result) {
  if (result.error) return `Ingest preview unavailable: ${result.error.message}`;
  const manifest = result.data.sourceManifest;
  const progress = result.data.progress;
  return [
    'Ingest preview: review_required',
    `Workspace: ${manifest.workspaceId}`,
    `Source: ${manifest.sourceType} ${manifest.sourceRef}`,
    `Hash: ${manifest.sourceDigest}`,
    `Progress: ${progress.completed}/${progress.total}`,
    `Next action: ${result.data.nextAction}`,
  ].join('\n');
}

function ingestPreviewArgv(args) {
  const readFlag = name => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 ? args[index + 1] : undefined;
  };
  return {
    sourceType: String(readFlag('type') || readFlag('source') || '').toLowerCase(),
    sourceRef: readFlag('ref') || '',
    workspaceId: readFlag('workspace'),
    text: readFlag('text') || '',
  };
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

    const gateResult = cli._evaluateCliGate(parsed.command, parsed.args);
    if (gateResult && !gateResult.canExecute) {
      const status = gateResult.decision === 'review' ? 'review_required' : 'blocked';
      const learnProposal = status === 'review_required' && workflowId === 'learn-review'
        && typeof cli._queueLearnReview === 'function'
        ? await cli._queueLearnReview(parsed.args)
        : null;
      if (parsedFlags.json) {
        write(cliEnvelope(workflowId, learnProposal || { data: { gate: gateResult } }, status));
      } else if (learnProposal?.approval?.id) {
        stdout(`Learn requires review. Approval queued: ${learnProposal.approval.id}`);
      } else {
        stdout(cli._formatCliGateMessage(parsed.command, gateResult));
      }
      return {
        interactive: false,
        exitCode: parsedFlags.json ? CLI_EXIT_CODES[status] : 3,
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
    const status = statusFromResult(output);
    write(parsedFlags.json ? cliEnvelope(workflowId, output, status) : (typeof output === 'string' ? output : JSON.stringify(output)));
    return {
      interactive: false,
      exitCode: parsedFlags.json ? (CLI_EXIT_CODES[status] ?? CLI_EXIT_CODES.failed) : 0,
      command: parsed.command,
      workflowId,
    };
  } catch (error) {
    const message = `Command error: ${error?.message || error}`;
    const unauthorized = error?.code === 'OPERATOR_AUTH_REQUIRED' || error?.exitCode === 4;
    const status = unauthorized ? 'unauthorized' : 'failed';
    if (parsedFlags.json) write(jsonError(workflowId, status, error?.code || 'COMMAND_FAILED', message, error?.meta)); else stderr(message);
    return { interactive: false, exitCode: parsedFlags.json ? CLI_EXIT_CODES[status] : (error?.exitCode || 1), workflowId };
  }
}

module.exports = { CLI_EXIT_CODES, workflowIdForCommand, splitJsonFlag, cliEnvelope, runCliArgv };
