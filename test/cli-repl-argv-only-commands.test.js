'use strict';

// #3638: `stop`, `lift`, `integrity` and the `ingest` family are argv-only --
// their logic lives in cli-workflow-adapter's runCliArgv. The interactive REPL
// parses a single text line instead, so typing one of these at the prompt fell
// through to "anlamadım" while the same words worked from the shell. The REPL
// now hands a line whose first word names one of these families to the argv
// dispatcher.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');

const CLI = require('../cli.js');
const { runCliRepl } = require('../lib/cli-repl');

function fakeReadline() {
  const rl = new EventEmitter();
  rl.closed = false;
  rl.prompt = () => {};
  rl.close = () => {
    rl.closed = true;
    rl.emit('close');
  };
  return rl;
}

// Drives one REPL line through a real CLI and returns what it printed.
async function runLine(line, environment) {
  const rl = fakeReadline();
  const originalCreateInterface = readline.createInterface;
  const originalLog = console.log;
  const originalExit = process.exit;
  const originalEnv = { ...process.env };
  const output = [];
  readline.createInterface = () => rl;
  console.log = (value) => { if (value !== undefined) output.push(String(value)); };
  process.exit = () => {};
  Object.assign(process.env, environment);
  try {
    const cli = new CLI({ kernel: { noLoad: true, loadPlugins: false } });
    runCliRepl(cli, { auditMutation: () => ({ auditRecorded: true }), commitMutation: () => '' });
    await rl.listeners('line')[0](line);
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  } finally {
    readline.createInterface = originalCreateInterface;
    console.log = originalLog;
    process.exit = originalExit;
    process.env = originalEnv;
  }
  return output.join('\n');
}

test('the REPL runs stop/lift through the argv dispatcher (#3638)', async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-repl-stop-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const stopped = await runLine('stop --scope workspace --workspace w-repl --reason incident', { HUQAN_EMERGENCY_STOP_DIR: dir });
  assert.match(stopped, /Stopped: workspace w-repl/, 'stop from the prompt must reach the ledger');

  const lifted = await runLine('lift --scope workspace --workspace w-repl', { HUQAN_EMERGENCY_STOP_DIR: dir });
  assert.match(lifted, /Lifted: workspace w-repl/, 'lift from the prompt must reach the ledger');
});

test('the REPL runs the read-only integrity check (#3638)', async (t) => {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'huqan-repl-integrity-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const out = await runLine('integrity', { HUQAN_EMERGENCY_STOP_DIR: dir });
  assert.match(out, /Ledger verifies/, 'integrity from the prompt must run');
});

test('the REPL runs ingest preview with a quoted text argument (#3638)', async () => {
  const out = await runLine('ingest preview --type manual --ref r1 --workspace default --text "the sky is blue"', {});
  assert.match(out, /Ingest preview: review_required/, 'ingest preview from the prompt must run');
  assert.match(out, /Source: manual r1/);
});

test('a line the parser already understands is never diverted to argv (#3638)', async () => {
  // `integrity` is argv-only, but `stop thinking` is the parser's own control
  // action (düşün dur); the fallback keys on anlamadım so it must not fire.
  const out = await runLine('stop thinking', {});
  assert.doesNotMatch(out, /Unknown command|Unknown option/, 'stop thinking must stay a parser command');
});
