'use strict';

// The operator surface for break-glass windows (İP-2), the `break-glass`
// subcommand of huqan-gate-hook.
//
// Three verbs, each marshalling CLI arguments into lib/break-glass.js and
// printing JSON with the entry point's exit-code contract:
//
//   break-glass status                 list every window and its live state
//   break-glass issue  --reason ...    open a window (reason required)
//   break-glass lift   --window <id>   end one before it expires
//
// The surface is deliberately separate from the hook evaluation path. Issuing
// a window is an operator act, done from a terminal; the hook path only ever
// *reads* a window whose id it was handed, and never mints one. That split is
// what keeps a compromised agent from opening its own window: the flag it can
// set names an id, and an id that no operator issued does not resolve.
//
// ## Who may issue (İP-2)
//
// `issue` and `lift` are operator decisions, so they carry the same operator
// credential `terfi` and `onayla` already use (lib/cli-operator-presence.js):
// the operator at an interactive terminal, who types the scope back. Without a
// terminal -- an agent's shell, a pipe, a heredoc -- the verb is refused as
// OPERATOR_AUTH_REQUIRED (exit 4) before the ledger is touched. `status` stays a
// read: it changes nothing, and the operator inspects windows with it.
//
// The credential itself lives at the composition root, not here: this module is
// AgentAction and the operator surface is Platform, so the entry point
// (bin/huqan-gate-hook.js) passes an `authorize(spec, act)` seam in. Without
// one, `issue` and `lift` refuse fail-closed -- a caller that forgot the
// operator check cannot accidentally get the ungated verb.
//
// That credential is the same-user boundary, and it is the whole of it: code
// running as the same OS user can still drive a pty. The OS boundary is the
// approval authority (ADR-016) -- the same place a blocked action is decided.
// The hook-side half refuses the verb from an agent's shell outright
// (lib/control-plane-paths.js, OPERATOR_DECISION_COMMANDS), which is what the
// agent actually meets: it never reaches this module.
//
// Exit codes: 0 on success, 1 on a refusal (an expired window, a missing
// reason, a broken ledger), 2 on an unknown verb, 4 when the operator is not at
// a terminal. A refusal is never a silent success, so an operator scripting
// this can branch on it.

const { argumentValue } = require('./gate-hook-input');
const { createBreakGlass, MAX_WINDOW_MS, MAX_USES } = require('./break-glass');

/** A positional argument of the gate CLI, e.g. the verb. */
function positionalArgument(index) {
  const value = process.argv[index];
  return typeof value === 'string' ? value.trim() : '';
}

function print(payload, exitCode, sink) {
  sink.write(`${JSON.stringify(payload, null, 2)}\n`);
  sink.setExitCode(exitCode);
}

/** The process's own output and exit code, unless a test injects its own. */
function defaultSink() {
  return {
    write: (line) => process.stdout.write(line),
    setExitCode: (code) => { process.exitCode = code; },
  };
}

function parseCategories(raw) {
  return typeof raw === 'string' && raw.trim() ? raw.split(',').map((entry) => entry.trim()).filter(Boolean) : [];
}

function parseInteger(raw) {
  if (raw === '' || raw === undefined) return undefined;
  const value = Number(raw);
  return Number.isInteger(value) ? value : Number.NaN;
}

/** Reject an out-of-range bound here so the refusal names the bound, not a generic failure. */
function invalidBound(ttlMs, maxUses) {
  if (Number.isNaN(ttlMs) || (ttlMs !== undefined && (ttlMs <= 0 || ttlMs > MAX_WINDOW_MS))) return true;
  if (Number.isNaN(maxUses) || (maxUses !== undefined && (maxUses <= 0 || maxUses > MAX_USES))) return true;
  return false;
}

// The operator credential for `issue` and `lift` (İP-2): the operator at an
// interactive terminal, who types the scope back. An agent's shell, a pipe or a
// heredoc has no terminal, so it is refused before the ledger is read.
function issueSpec() {
  return { command: 'break-glass issue', subject: 'workspace', expected: argumentValue('--workspace-id', 'default') };
}

function liftSpec(windowId) {
  return { command: 'break-glass lift', subject: 'window id', expected: windowId };
}

/**
 * Run `act` only once the operator confirmed at a terminal. The `authorize`
 * seam is injected by the composition root (bin/huqan-gate-hook.js), which
 * holds the operator credential; this module is AgentAction and may not import
 * a Platform entrypoint. Without the seam the verb is refused fail-closed, so a
 * caller that forgot to wire the operator check cannot get the ungated verb.
 *
 * A refusal is printed as OPERATOR_AUTH_REQUIRED with exit 4, never a silent
 * success.
 */
function withOperatorPresence(authorize, spec, act, sink) {
  if (typeof authorize !== 'function') {
    print({ error: 'OPERATOR_AUTH_REQUIRED', message: `${spec.command}: no operator authorization is wired (operator_authorization_unavailable)` }, 4, sink);
    return Promise.resolve();
  }
  return Promise.resolve()
    .then(() => authorize(spec, act))
    .catch((error) => {
      print({ error: error?.code || 'OPERATOR_AUTH_REQUIRED', message: error?.message || String(error) }, error?.exitCode || 4, sink);
    });
}

async function runBreakGlassCommand(opts = {}) {
  const sink = opts.sink || defaultSink();
  const authorize = opts.authorize;
  const verb = positionalArgument(3) || 'status';
  // The ledger directory is deployment configuration (HUQAN_BREAK_GLASS_DIR or
  // the state root), never a request field: an agent that could name the path
  // could point the guard at a ledger it wrote itself. There is no `--dir`.
  const ledger = createBreakGlass();

  if (verb === 'status') {
    const status = ledger.status();
    print(status, status.ok ? 0 : 1, sink);
    return;
  }

  if (verb === 'issue') {
    const ttlMs = parseInteger(argumentValue('--ttl-ms'));
    const maxUses = parseInteger(argumentValue('--max-uses'));
    if (invalidBound(ttlMs, maxUses)) {
      print({ error: 'BREAK_GLASS_INVALID_BOUND', hint: `ttl-ms must be an integer between 1 and ${MAX_WINDOW_MS}, max-uses an integer between 1 and ${MAX_USES}` }, 1, sink);
      return;
    }
    // Argument validation runs before the operator check, as `onayla` does, so
    // a missing reason is a refusal the operator can read without a terminal.
    // lib/break-glass.js enforces the same rule on the write, as defence in depth.
    if (!argumentValue('--reason').trim()) {
      print({ error: 'BREAK_GLASS_ISSUE_FAILED', message: 'a break-glass window needs a reason' }, 1, sink);
      return;
    }
    await withOperatorPresence(authorize, issueSpec(), () => {
      try {
        const result = ledger.issue({
          workspaceId: argumentValue('--workspace-id', 'default'),
          agentId: argumentValue('--agent-id'),
          reason: argumentValue('--reason'),
          actor: argumentValue('--actor') || 'operator:cli',
          operatorIdentity: argumentValue('--operator-identity'),
          ...(ttlMs === undefined ? {} : { ttlMs }),
          ...(maxUses === undefined ? {} : { maxUses }),
          categories: parseCategories(argumentValue('--categories')),
        });
        print(result, result.ok ? 0 : 1, sink);
      } catch (error) {
        print({ error: error.code || 'BREAK_GLASS_ISSUE_FAILED', message: error.message }, 1, sink);
      }
    }, sink);
    return;
  }

  if (verb === 'lift') {
    // The window id is validated before the operator check, as `issue` validates
    // its reason: a missing id is a refusal the operator can read without a
    // terminal, and it names a window that does not exist rather than prompting
    // for a confirmation of nothing.
    const windowId = argumentValue('--window');
    if (!windowId) {
      print({ ok: false, lifted: false, reason: 'break_glass_window_not_found' }, 1, sink);
      return;
    }
    await withOperatorPresence(authorize, liftSpec(windowId), () => {
      try {
        const result = ledger.lift({
          windowId,
          actor: argumentValue('--actor') || 'operator:cli',
          reason: argumentValue('--reason'),
        });
        print(result, result.ok ? 0 : 1, sink);
      } catch (error) {
        print({ error: error.code || 'BREAK_GLASS_LIFT_FAILED', message: error.message }, 1, sink);
      }
    }, sink);
    return;
  }

  print({ error: 'UNKNOWN_BREAK_GLASS_COMMAND', verb, hint: 'verbs: status, issue, lift' }, 2, sink);
}

module.exports = { runBreakGlassCommand };
