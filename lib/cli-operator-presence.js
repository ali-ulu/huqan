'use strict';

// Operator presence for CLI commands that record an operator's decision
// (#3560): `terfi` approving a promotion, `onayla`/`approve` deciding a
// queued approval.
//
// The OS session the CLI runs in does not tell a human from an agent running
// as the same user, so such a decision needs the operator at an interactive
// terminal who types the decision's subject back. Without a terminal -- an
// agent's shell, a pipe, a heredoc fed to the REPL -- it is refused at once
// as OPERATOR_AUTH_REQUIRED (exit 4) before anything runs. The hook-side half
// refuses these commands from an agent's shell outright
// (lib/control-plane-paths.js).
//
// What this cannot stop: code running as the same OS user can drive a pty or
// load the CLI in-process and replace these checks. Only an OS boundary --
// HUQAN's authority held by another user or service -- separates that.

const readline = require('node:readline');

// Asks once on an open readline interface. EOF never calls the question
// callback, so a close settles the answer as empty: a declined decision
// rather than a promise that never ends.
function askOnce(rl, prompt) {
  return new Promise((resolve) => {
    // Already closed: the close event is gone and question() would throw.
    if (rl.closed === true) {
      resolve('');
      return;
    }
    const onClose = () => resolve('');
    rl.once('close', onClose);
    rl.question(prompt, (answer) => {
      rl.removeListener('close', onClose);
      resolve(answer);
    });
  });
}

function terminalAsk(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  return askOnce(rl, prompt).finally(() => rl.close());
}

/**
 * Refuses at once without an interactive terminal; otherwise resolves once
 * the operator typed `expected` back.
 *
 * @returns {{ok: false, code: string} | Promise<{ok: boolean, code?: string}>}
 */
function confirmOperatorPresence({ command, subject, expected }, { input = process.stdin, ask = terminalAsk } = {}) {
  if (!input || input.isTTY !== true) return { ok: false, code: 'operator_terminal_required' };
  return Promise.resolve(ask(`${command}: type the ${subject} (${expected}) to confirm: `))
    .then((answer) => (String(answer ?? '').trim() === expected ? { ok: true } : { ok: false, code: 'operator_confirmation_mismatch' }));
}

function operatorAuthError(command, code) {
  const error = new Error(`${command}: this decision needs the operator at an interactive terminal (${code})`);
  error.exitCode = 4;
  error.code = 'OPERATOR_AUTH_REQUIRED';
  return error;
}

/**
 * Run `run` only once the operator confirmed at a terminal. `opts` carries the
 * in-process seams (`operatorInput`, `operatorAsk`); the REPL passes its own
 * `operatorAsk` so the answer is not read as its next command.
 */
function requireOperatorPresence(spec, opts, run) {
  const presence = confirmOperatorPresence(spec, { input: opts?.operatorInput, ask: opts?.operatorAsk });
  if (typeof presence.then !== 'function') throw operatorAuthError(spec.command, presence.code);
  return presence.then((confirmed) => {
    if (!confirmed.ok) throw operatorAuthError(spec.command, confirmed.code);
    return run();
  });
}

module.exports = { askOnce, confirmOperatorPresence, operatorAuthError, requireOperatorPresence };
