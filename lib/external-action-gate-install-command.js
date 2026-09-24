'use strict';
// #2145: which spelling of the gate entry gets recorded in a host's config.
// Candidates are ordered by portability and each is proved by running it
// against the sentinel, never assumed to work.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { fail } = require('./external-action-gate-install-spec');
const {
  sentinelPayload, evaluatorExpectation, exerciseCommand, exerciseBrowserOutcome, startsWithoutShell,
} = require('./external-action-gate-install-sentinel');
const GATE_BIN = path.resolve(__dirname, '..', 'bin', 'huqan-gate-hook.js');

/**
 * Windows short name (`C:\PROGRA~1\...`) for a path with spaces.
 *
 * Quoting is not an option here: a hook command is a string the *host* hands
 * to a shell, and `"C:\Program Files\nodejs\node.exe" script.js` is a parser
 * error in PowerShell, which needs `& "..."` -- while `&` at the front is a
 * syntax error in cmd.exe. No quoted spelling runs in both, so the way out is
 * a path with no spaces to quote (#1797).
 */
// The path reaches cmd.exe through an environment variable, never spliced
// into the command line, so the command itself is a constant. A double quote
// or `%` in the value would still end the quoted operand or expand inside it
// once cmd substitutes it, and a line break would end the command, so such a
// path is returned as is and, still holding its space, dropped by
// gateCommandCandidates. `cmd.exe` is named literally rather than read from
// ComSpec, which any parent process can set.
// The quote is written \x22: scripts/binding-site-scan.js does not recognise
// regex literals, and a raw quote here would hide the spawn below from it.
const CMD_UNSAFE = /[\x22%\r\n]/;
const SHORT_NAME_COMMAND = 'for %I in ("%HUQAN_GATE_SHORTNAME_TARGET%") do @echo %~sI';
function unspaced(target) {
  if (process.platform !== 'win32' || !/\s/.test(target) || CMD_UNSAFE.test(target)) return target;
  // windowsVerbatimArguments: true stops Node from MSVC-quoting SHORT_NAME_COMMAND's
  // own `"..."` before cmd.exe sees it -- the escaped `\"` that quoting produces is not
  // a quote cmd.exe understands (#2838).
  const run = spawnSync('cmd.exe', ['/d', '/s', '/c', SHORT_NAME_COMMAND], {
    encoding: 'utf8', windowsVerbatimArguments: true, env: { ...process.env, HUQAN_GATE_SHORTNAME_TARGET: target },
  });
  const short = String(run.stdout || '').trim();
  return short && !/\s/.test(short) && fs.existsSync(short) ? short : target;
}

/** PATH lookup with PATHEXT, the way a shell resolves a bare command name. */
function onSearchPath(name, environment) {
  const extensions = process.platform === 'win32'
    ? (environment.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
    : [''];
  return (environment.PATH || environment.Path || '').split(path.delimiter).filter(Boolean).some(dir => extensions
    .some(extension => fs.existsSync(path.join(dir.replace(/^"|"$/g, ''), `${name}${extension}`))));
}

/**
 * Spellings of the gate entry, most portable first: an explicit
 * HUQAN_GATE_PATH (the same knob the Hermes plugin reads), the name on PATH,
 * the workspace's own bin shim, `node` plus this package's entry, and the
 * absolute Node binary as a last resort.
 *
 * The templates used to record `huqan-gate --profile X` verbatim, which only
 * works where that name is on PATH. When it is not, the host still runs the
 * hook, the command fails to start, and the host decides what a failed hook
 * means -- Codex runs the tool anyway (#1797), which is the quiet loss of the
 * whole guard.
 *
 * Candidates that still carry a space after `unspaced` are dropped rather than
 * quoted, because a quoted path cannot be written to run in both cmd.exe and
 * PowerShell. Which candidate survives is decided by running it, not by
 * guessing -- see `pickGateCommand`.
 */
function gateCommandCandidates(root, environment = process.env) {
  const configured = String(environment.HUQAN_GATE_PATH || '').trim();
  const shim = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'huqan-gate.cmd' : 'huqan-gate');
  return [
    ...(configured ? [unspaced(configured)] : []),
    ...(onSearchPath('huqan-gate', environment) ? ['huqan-gate'] : []),
    ...(fs.existsSync(shim) ? [unspaced(shim)] : []),
    ...(onSearchPath('node', environment) ? [`node ${unspaced(GATE_BIN)}`] : []),
    `${unspaced(process.execPath)} ${unspaced(GATE_BIN)}`,
    // At most `<launcher> <script>`: more tokens than that means `unspaced`
    // could not remove a space, and the candidate would need quoting.
  ].filter(candidate => candidate.split(' ').length <= 2 && !candidate.includes('"'));
}

/**
 * Pick the command to record by running each candidate, rather than by
 * assuming a spelling works. The first one that blocks the sentinel under
 * every available shell is recorded; if none does, the install refuses and
 * says what it tried, because writing an unrunnable hook is worse than not
 * installing.
 */
function pickGateCommand(profile, root) {
  const payload = sentinelPayload(profile, root);
  const expected = evaluatorExpectation(profile, root, payload);
  const rejected = [];
  for (const candidate of gateCommandCandidates(root)) {
    const invocation = `${candidate} --profile ${profile}`;
    try {
      const outcome = exerciseCommand(invocation, payload, root);
      if (outcome.shells.every(result => result.decision === expected.decision && result.reason.includes(expected.reason))) {
        if (profile === 'claude-code') exerciseBrowserOutcome(candidate, root);
        // Hermes runs the argv itself, so passing under a shell is not enough
        // evidence for that profile -- see `startsWithoutShell`.
        if (profile !== 'hermes' || startsWithoutShell(invocation, payload, root)) return candidate;
        rejected.push(`${invocation}: runs under a shell but cannot be started as an argv, which is how Hermes runs it`);
        continue;
      }
      rejected.push(`${invocation}: decided ${outcome.shells.map(result => `${result.shell}=${result.decision}`).join(', ')}`);
    } catch (error) {
      rejected.push(`${invocation}: ${error.message}`);
    }
  }
  fail(`no gate command runs in this host's shells. Tried:\n  ${rejected.join('\n  ')}`);
}

module.exports = Object.freeze({ pickGateCommand, unspaced });
