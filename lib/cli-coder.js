'use strict';

/**
 * `coder` CLI command — run one deterministic coding task.
 *
 *   coder <task.json> [--dry-run] [--root <dir>] [--json]
 *
 * There is no language model anywhere in this path. The task names a transform
 * from lib/deterministic-task-runner.js; the transform is a pure function; the
 * gate decides whether the resulting patch may land. What the command prints is
 * a derivation record, not a report the tool wrote about itself.
 *
 * Branch and dirtiness are read from git here rather than inside
 * applyDerivation, because asking git is an I/O concern and the pipeline is
 * meant to stay a plain function over explicit inputs. If git cannot be
 * reached, the repo state is reported as unknown and passed through as such --
 * the gate then treats it as a clean non-main tree, so this command says so out
 * loud instead of letting an unverified assumption pass silently.
 */

const childProcess = require('node:child_process');
const fs = require('node:fs');
const nodePath = require('node:path');

const { DERIVATION_OUTCOMES } = require('./coder/derivation-record');
const { applyDerivation } = require('./coder/apply-derivation');

function cliError(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

function toTokens(args) {
  if (Array.isArray(args)) return args.map(String).filter(Boolean);
  return String(args || '').trim().split(/\s+/u).filter(Boolean);
}

function parseCoderArgs(args) {
  const tokens = toTokens(args);
  const flags = { taskFile: '', dryRun: false, root: '' };
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--dry-run') {
      flags.dryRun = true;
    } else if (token === '--root') {
      flags.root = tokens[index + 1] || '';
      index += 1;
    } else if (token === '--json') {
      // Handled by the caller via opts.json; accepted here so it is not
      // mistaken for the task file when it appears first.
    } else if (!flags.taskFile && !token.startsWith('--')) {
      flags.taskFile = token;
    }
  }
  return flags;
}

function readTask(taskFile) {
  let raw;
  try {
    raw = fs.readFileSync(taskFile, 'utf8');
  } catch (error) {
    throw cliError(`Task file could not be read: ${error.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    throw cliError(`Task file is not valid JSON: ${error.message}`);
  }
}

function git(root, args) {
  return childProcess.execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
}

/**
 * Best-effort repo state. `known: false` is returned rather than a guess when
 * git is unavailable or the directory is not a repository, so a caller reading
 * the output can tell "clean tree" apart from "nobody checked".
 */
function readRepoState(root) {
  try {
    const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const status = git(root, ['status', '--porcelain']);
    const lines = status ? status.split('\n').filter(Boolean) : [];
    return {
      known: true,
      branch,
      dirty: lines.some(line => !line.startsWith('??')),
      hasUntracked: lines.some(line => line.startsWith('??')),
    };
  } catch {
    return { known: false, branch: '', dirty: false, hasUntracked: false };
  }
}

function formatCoderText(result, repoState) {
  const lines = [];
  const record = result.record;
  lines.push(`Task:       ${record.taskId || '(unnamed)'}`);
  lines.push(`Transform:  ${record.operationType || '(none)'} (catalog ${record.catalogVersion})`);
  lines.push(`Runner:     ${record.runnerStatus}${record.runnerReason ? ` — ${record.runnerReason}` : ''}`);
  lines.push(`Gate:       ${record.gate.decision || '(not reached)'}${record.gate.reason ? ` — ${record.gate.reason}` : ''}`);
  lines.push(`Outcome:    ${result.outcome}${result.reason ? ` — ${result.reason}` : ''}`);
  if (result.detail) lines.push(`Detail:     ${result.detail}`);
  if (!repoState.known) lines.push('Repo state: unknown (git unavailable) — gate saw a clean, non-main tree');
  lines.push(`Derivation: ${record.derivationHash}`);
  lines.push(`Record:     ${record.recordHash}`);

  if (record.patch.length) {
    lines.push('');
    lines.push(result.outcome === DERIVATION_OUTCOMES.APPLIED ? 'Files written:' : 'Files that would change:');
    for (const change of record.patch) lines.push(`  ${change.path}`);
  }
  return lines.join('\n');
}

function runCliCoder(args, opts = {}) {
  const tokens = toTokens(args);
  // `coder verify ...` is the other half of the same command: one side derives,
  // the other re-derives. It lives in its own module because the verifier is
  // meant to be run by someone who did not produce the patch, and keeping the
  // two apart makes that separation visible rather than implied.
  if (tokens[0] === 'verify') {
    return require('./cli-coder-verify').runCliCoderVerify(tokens.slice(1), opts);
  }

  const flags = parseCoderArgs(args);
  if (!flags.taskFile) {
    throw cliError('Usage: coder <task.json> [--dry-run] [--root <dir>] [--json]');
  }

  const root = nodePath.resolve(flags.root || process.cwd());
  const task = readTask(flags.taskFile);
  const repoState = readRepoState(root);

  const result = applyDerivation({
    task,
    root,
    repoState: { branch: repoState.branch, dirty: repoState.dirty, hasUntracked: repoState.hasUntracked },
    dryRun: flags.dryRun,
    workspaceId: opts.workspaceId || 'default',
  });

  if (opts.json) {
    return {
      status: result.ok ? 'completed' : 'refused',
      data: {
        outcome: result.outcome,
        reason: result.reason,
        detail: result.detail,
        repoStateKnown: repoState.known,
        record: result.record,
      },
    };
  }
  return formatCoderText(result, repoState);
}

module.exports = {
  parseCoderArgs,
  readRepoState,
  formatCoderText,
  runCliCoder,
};
