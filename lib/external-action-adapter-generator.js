'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

/**
 * Write a ready adapter for a custom agent (#2061).
 *
 * `connect` removed the profile-name question for the five detectable agents.
 * For everything else, the answer was a sentence -- "send the envelope to
 * huqan-gate --profile generic" -- and the user was left to write the envelope
 * construction, the subprocess call and the decision handling themselves. That
 * is the one place a governance product loses people, because writing it wrong
 * fails OPEN and looks fine.
 *
 * The gate command is not guessed. Every candidate is run against a denylisted
 * command and must answer `block` with DENYLISTED_COMMAND_BLOCKED before it is
 * written into the adapter. Proving with the wrong payload shape is the trap
 * documented for the Pi profile in external-action-gate-install.js: a
 * claude-code-shaped payload sent to the generic profile normalizes to
 * `toolName: undefined` and blocks as malformed input -- which proves the
 * malformed path, not the denylist. So the sentinel here is a real
 * huqan.external-action.v1 envelope, and the reason is checked, not just the
 * decision.
 */

const ADAPTER_TEMPLATE = path.resolve(__dirname, '..', 'adapters', 'external-action', 'generic-adapter.js');
const GATE_BIN = path.resolve(__dirname, '..', 'bin', 'huqan-gate-hook.js');
// Quoted, because the replacement is a JSON string literal rather than raw
// text: a Windows path written straight into the template turns \U, \b and
// friends into escape sequences and mangles the path. It failed closed -- the
// adapter blocked everything, including `git status` -- but a gate that
// refuses every action is not enforcement, it is a broken install.
const COMMAND_PLACEHOLDER = "'__HUQAN_GATE_COMMAND__'";
const SENTINEL_REASON = 'DENYLISTED_COMMAND_BLOCKED';
const SENTINEL_TIMEOUT_MS = 30000;
const DEFAULT_FILENAME = 'huqan-adapter.js';

function unspaced(target) {
  return target.includes(' ') ? `"${target}"` : target;
}

function onSearchPath(name, environment) {
  const extensions = process.platform === 'win32'
    ? String(environment.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  return String(environment.PATH || environment.Path || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some(dir => extensions.some(extension => {
      try {
        return fs.existsSync(path.join(dir.replace(/^"|"$/g, ''), `${name}${extension}`));
      } catch (_) {
        return false;
      }
    }));
}

function gateCommandCandidates(root, environment = process.env) {
  const configured = String(environment.HUQAN_GATE_PATH || '').trim();
  const shim = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'huqan-gate.cmd' : 'huqan-gate');
  return [
    ...(configured ? [unspaced(configured)] : []),
    ...(onSearchPath('huqan-gate', environment) ? ['huqan-gate'] : []),
    ...(fs.existsSync(shim) ? [unspaced(shim)] : []),
    ...(onSearchPath('node', environment) ? [`node ${unspaced(GATE_BIN)}`] : []),
    `${unspaced(process.execPath)} ${unspaced(GATE_BIN)}`,
  ].filter(candidate => candidate.split(' ').length <= 2 && !candidate.includes('"'));
}

/** A real envelope, so the block that proves the command is the denylist's. */
function sentinelEnvelope(root) {
  return {
    schemaVersion: 'huqan.external-action.v1',
    invocationId: 'huqan-adapter-sentinel',
    agentName: 'huqan-adapter-sentinel',
    sessionId: 'huqan-adapter-sentinel',
    toolName: 'shell',
    kind: 'shell',
    args: { command: 'rm -rf /' },
    cwd: root,
    workspaceRoot: root,
    workspaceId: 'default',
  };
}

function exercise(command, root) {
  const argv = command.split(' ');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-adapter-sentinel-'));
  try {
    const run = spawnSync(argv[0], [...argv.slice(1), '--profile', 'generic', '--receipt-log', path.join(scratch, 'receipts.jsonl')], {
      input: JSON.stringify(sentinelEnvelope(root)),
      cwd: root,
      encoding: 'utf8',
      timeout: SENTINEL_TIMEOUT_MS,
    });
    if (run.error) return { ok: false, why: run.error.message };
    let decision;
    try {
      decision = JSON.parse(run.stdout || '');
    } catch (_) {
      return { ok: false, why: `output was not JSON: ${String(run.stdout || run.stderr || '').trim().slice(0, 120)}` };
    }
    if (decision.decision !== 'block') return { ok: false, why: `answered ${decision.decision}, not block` };
    // The reason matters: blocking as malformed input would prove the wrong path.
    if (decision.reason !== SENTINEL_REASON) return { ok: false, why: `blocked as ${decision.reason}, not ${SENTINEL_REASON}` };
    return { ok: true, decision: decision.decision, reason: decision.reason };
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

function proveGateCommand(root, environment) {
  const rejected = [];
  for (const candidate of gateCommandCandidates(root, environment)) {
    const outcome = exercise(candidate, root);
    if (outcome.ok) return { command: candidate, sentinel: { decision: outcome.decision, reason: outcome.reason } };
    rejected.push(`${candidate}: ${outcome.why}`);
  }
  const error = new Error(`no gate command could be proven. Tried:\n  ${rejected.join('\n  ')}`);
  error.rejected = rejected;
  throw error;
}

/**
 * @param {object} [options]
 * @param {string} [options.root] project directory to write into
 * @param {string} [options.out] adapter path, relative to root unless absolute
 * @param {string} [options.agentName] name the snippet uses
 * @param {boolean} [options.force] overwrite an existing adapter
 */
function writeCustomAgentAdapter(options = {}) {
  const root = path.resolve(options.root || process.cwd());
  const target = path.resolve(root, options.out || DEFAULT_FILENAME);
  if (fs.existsSync(target) && options.force !== true) {
    const error = new Error(`${target} already exists; pass force to overwrite`);
    error.code = 'ADAPTER_EXISTS';
    throw error;
  }

  // Proven before anything is written, so a failure leaves no adapter behind
  // for the user to trust.
  const proof = proveGateCommand(root, options.environment);
  const template = fs.readFileSync(ADAPTER_TEMPLATE, 'utf8');
  if (!template.includes(COMMAND_PLACEHOLDER)) {
    throw new Error(`adapter template is missing ${COMMAND_PLACEHOLDER}`);
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, template.replace(COMMAND_PLACEHOLDER, JSON.stringify(proof.command)), { mode: 0o644 });

  const agentName = String(options.agentName || 'my-agent');
  const relative = path.relative(root, target).split(path.sep).join('/');
  return {
    command: 'adapter',
    target,
    gateCommand: proof.command,
    sentinel: proof.sentinel,
    agentName,
    // The one line to add, and the payload that proves it once added.
    callSite: [
      `const { huqanCheck } = require('./${relative}');`,
      '',
      '// immediately before your agent executes a tool call:',
      `huqanCheck({ agentName: '${agentName}', toolName: 'shell', kind: 'shell', args: { command }, cwd });`,
      '// throws HuqanBlocked on review or block; let it propagate.',
    ].join('\n'),
    verify: 'huqan-gate status --profile generic',
    testPayload: {
      expect: 'block',
      envelope: { ...sentinelEnvelope(root), agentName },
    },
  };
}

module.exports = {
  ADAPTER_TEMPLATE,
  COMMAND_PLACEHOLDER,
  SENTINEL_REASON,
  gateCommandCandidates,
  proveGateCommand,
  writeCustomAgentAdapter,
};
