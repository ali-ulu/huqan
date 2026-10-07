'use strict';

// #3560: a REPL command that asks the operator (terfi) asks through the
// REPL's own prompt, and every way stdin can end settles the question as a
// declined (empty) answer instead of hanging or throwing.

const test = require('node:test');
const assert = require('node:assert/strict');
const readline = require('node:readline');
const { EventEmitter } = require('node:events');
const { runCliRepl } = require('../lib/cli-repl');

function fakeReadline() {
  const rl = new EventEmitter();
  rl.closed = false;
  rl.prompt = () => {};
  rl.question = (prompt, callback) => {
    rl.asked = prompt;
    rl.pending = callback;
  };
  rl.close = () => {
    rl.closed = true;
    rl.emit('close');
  };
  return rl;
}

// Drives one REPL line whose command asks the operator, with `act` playing
// stdin once the question is out; returns what the command received.
async function askThroughRepl(act) {
  const rl = fakeReadline();
  const originalCreateInterface = readline.createInterface;
  const originalLog = console.log;
  const originalExit = process.exit;
  let answered;
  const cli = {
    parse: () => ({ command: 'terfi', args: '' }),
    execute: (command, args, opts) => opts.operatorAsk('type the version: ').then((answer) => {
      answered = answer;
      return 'done';
    }),
  };
  readline.createInterface = () => rl;
  console.log = () => {};
  process.exit = () => {};
  try {
    runCliRepl(cli, { auditMutation: () => ({ auditRecorded: true }), commitMutation: () => '' });
    const line = rl.listeners('line')[0]('terfi');
    await new Promise((resolve) => setImmediate(resolve));
    act(rl);
    await line;
    await new Promise((resolve) => setImmediate(resolve));
    return { answered, rl };
  } finally {
    readline.createInterface = originalCreateInterface;
    console.log = originalLog;
    process.exit = originalExit;
  }
}

test('#3560 the REPL asks the operator through its own prompt and passes the answer on', async () => {
  const { answered, rl } = await askThroughRepl((repl) => repl.pending('v2'));
  assert.equal(rl.asked, 'type the version: ');
  assert.equal(answered, 'v2');
  assert.equal(rl.listenerCount('close'), 1, 'only the REPL\'s own close handler remains');
});

test('#3560 stdin closing while the REPL waits for an answer declines it', async () => {
  const { answered } = await askThroughRepl((repl) => repl.close());
  assert.equal(answered, '');
});

test('#3560 a declined approval is reported in the REPL and the prompt comes back', async () => {
  const rl = fakeReadline();
  const originalCreateInterface = readline.createInterface;
  const originalError = console.error;
  const errors = [];
  let prompts = 0;
  rl.prompt = () => { prompts += 1; };
  const cli = {
    parse: () => ({ command: 'terfi', args: '' }),
    // What terfi does when the typed version does not match.
    execute: () => Promise.reject(Object.assign(new Error('terfi: an approval needs the operator at an interactive terminal (operator_confirmation_mismatch)'), { code: 'OPERATOR_AUTH_REQUIRED' })),
  };
  readline.createInterface = () => rl;
  console.error = (message) => errors.push(message);
  try {
    runCliRepl(cli, { auditMutation: () => ({ auditRecorded: true }), commitMutation: () => '' });
    const before = prompts;
    await rl.listeners('line')[0]('terfi').catch(() => {});
    await new Promise((resolve) => setImmediate(resolve));
    assert.match(errors.join('\n'), /operator_confirmation_mismatch/);
    assert.equal(prompts, before + 1, 'the REPL prompts again after the refusal');
  } finally {
    readline.createInterface = originalCreateInterface;
    console.error = originalError;
  }
});

test('#3560 a REPL line queued after stdin closed declines without asking', async () => {
  const rl = fakeReadline();
  const originalCreateInterface = readline.createInterface;
  const originalLog = console.log;
  const originalExit = process.exit;
  let answered;
  const cli = {
    parse: () => ({ command: 'terfi', args: '' }),
    execute: (command, args, opts) => opts.operatorAsk('type the version: ').then((answer) => {
      answered = answer;
      return 'done';
    }),
  };
  rl.question = () => { throw new Error('ERR_USE_AFTER_CLOSE'); };
  readline.createInterface = () => rl;
  console.log = () => {};
  process.exit = () => {};
  try {
    runCliRepl(cli, { auditMutation: () => ({ auditRecorded: true }), commitMutation: () => '' });
    rl.closed = true;
    await rl.listeners('line')[0]('terfi');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(answered, '');
  } finally {
    readline.createInterface = originalCreateInterface;
    console.log = originalLog;
    process.exit = originalExit;
  }
});
