'use strict';

/**
 * #413 — the tools/call handler used to return `INTERNAL: ${err.message}` to
 * the client. An uncaught exception's message carries whatever the failing
 * layer happened to say: filesystem paths, driver error codes, internal
 * identifiers. An MCP client is not a trusted operator console.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createServer, recordInternalError } = require('../mcpServer');

const SECRET_DETAIL = 'SQLITE_CANTOPEN: unable to open /home/operator/private/memory.db';

/** A kernel whose read path throws, so tools/call reaches its catch block. */
function throwingKernel() {
  return {
    learn() {},
    verify() {},
    graph: {},
    ask() { throw new Error(SECRET_DETAIL); },
  };
}

function callAsk(kernel) {
  return createServer({ kernel }).handleRequest({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'axiom.ask', arguments: { question: 'kedi nedir?' } },
  });
}

function withSilencedStderr(fn) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => lines.push(args);
  try {
    return { result: fn(), lines };
  } finally {
    console.error = original;
  }
}

test('an internal exception is not relayed to the client', () => {
  const { result } = withSilencedStderr(() => callAsk(throwingKernel()));
  const serialized = JSON.stringify(result);

  assert.equal(serialized.includes('/home/operator/private'), false, 'leaked a filesystem path');
  assert.equal(serialized.includes('SQLITE_CANTOPEN'), false, 'leaked a driver error code');
  assert.equal(serialized.includes(SECRET_DETAIL), false, 'leaked the exception message');
});

test('the client still gets a usable error response', () => {
  const { result } = withSilencedStderr(() => callAsk(throwingKernel()));

  assert.equal(result.result.isError, true, 'the failure must still be reported as one');
  assert.match(result.result.content[0].text, /^INTERNAL_ERROR \(ref: [0-9a-f]{8}\)$/,
    'a stable generic message plus a reference the operator can correlate');
});

test('the reference differs per occurrence, so two failures can be told apart', () => {
  const { result: first } = withSilencedStderr(() => callAsk(throwingKernel()));
  const { result: second } = withSilencedStderr(() => callAsk(throwingKernel()));

  assert.notEqual(first.result.content[0].text, second.result.content[0].text);
});

test('the detail is written to stderr, where the protocol stream is not', () => {
  // stdout carries JSON-RPC frames; diagnostics there would corrupt them.
  const { lines } = withSilencedStderr(() => callAsk(throwingKernel()));

  assert.equal(lines.length, 1, 'exactly one diagnostic per failure');
  const [label, err] = lines[0];
  assert.match(label, /\[mcp\]\[tools\/call\] internal error ref=[0-9a-f]{8}/);
  assert.equal(err.message, SECRET_DETAIL, 'the operator keeps the full detail');
});

test('the reference in the response matches the one logged', () => {
  const { result, lines } = withSilencedStderr(() => callAsk(throwingKernel()));

  const shown = /ref: ([0-9a-f]{8})/.exec(result.result.content[0].text)[1];
  assert.ok(String(lines[0][0]).includes(shown),
    'a reference the operator cannot find in the log would be useless');
});

test('a failing logger does not swallow the response', () => {
  const original = console.error;
  console.error = () => { throw new Error('stderr is closed'); };
  try {
    const result = callAsk(throwingKernel());
    assert.equal(result.result.isError, true,
      'a failure while reporting a failure must not replace the caller\'s response');
  } finally {
    console.error = original;
  }
});

test('recordInternalError returns a reference without throwing on odd input', () => {
  const original = console.error;
  console.error = () => {};
  try {
    for (const value of [undefined, null, 'string error', { code: 'X' }, new Error('boom')]) {
      assert.match(recordInternalError('scope', value), /^[0-9a-f]{8}$/);
    }
  } finally {
    console.error = original;
  }
});
