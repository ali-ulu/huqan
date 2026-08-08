'use strict';

/**
 * Regression coverage for #414.
 *
 * runStdio() called `server.handleRequest(message)` outside any try/catch, so
 * a throw escaped the readline 'line' listener and became an uncaught
 * exception -- killing the whole MCP stdio process. Because stdio MCP is one
 * long-lived session, that turns a single bad request into the loss of every
 * request that would have followed it.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { handleStdioLine } = require('../mcpServer');

/** Collects what the handler would have written to stdout. */
function collector() {
  const sent = [];
  return { sent, send: msg => sent.push(msg) };
}

function throwingServer(error) {
  return { handleRequest() { throw error; } };
}

test('a throwing handleRequest does not propagate out of the line handler (#414)', () => {
  const { sent, send } = collector();
  const shutdowns = [];

  assert.doesNotThrow(() => {
    handleStdioLine('{"jsonrpc":"2.0","id":7,"method":"tools/call"}', {
      server: throwingServer(new Error('boom')),
      send,
      onShutdown: () => shutdowns.push(true),
    });
  });

  assert.equal(sent.length, 1);
  assert.equal(sent[0].jsonrpc, '2.0');
  assert.equal(sent[0].error.code, -32603);
  assert.equal(sent[0].error.message, 'Internal error');
  assert.equal(shutdowns.length, 0);
});

test('the error response echoes the request id so the client can correlate (#414)', () => {
  const { sent, send } = collector();
  handleStdioLine('{"jsonrpc":"2.0","id":"abc-123","method":"tools/call"}', {
    server: throwingServer(new Error('boom')),
    send,
    onShutdown: () => {},
  });
  assert.equal(sent[0].id, 'abc-123');
});

test('a notification without an id gets a null id, not undefined (#414)', () => {
  const { sent, send } = collector();
  handleStdioLine('{"jsonrpc":"2.0","method":"notifications/initialized"}', {
    server: throwingServer(new Error('boom')),
    send,
    onShutdown: () => {},
  });
  assert.equal(sent[0].id, null);
  assert.ok('id' in sent[0]);
});

test('the exception message is not leaked to the client (#414)', () => {
  const { sent, send } = collector();
  const secret = 'sk-live-do-not-leak-me';
  handleStdioLine('{"jsonrpc":"2.0","id":1,"method":"tools/call"}', {
    server: throwingServer(new Error(`db failure: ${secret}`)),
    send,
    onShutdown: () => {},
  });
  assert.doesNotMatch(JSON.stringify(sent[0]), new RegExp(secret));
});

test('a non-Error throw is still contained (#414)', () => {
  const { sent, send } = collector();
  assert.doesNotThrow(() => {
    handleStdioLine('{"jsonrpc":"2.0","id":2,"method":"tools/call"}', {
      server: throwingServer('a bare string'),
      send,
      onShutdown: () => {},
    });
  });
  assert.equal(sent[0].error.code, -32603);
});

test('the session survives: a good request after a throwing one still answers (#414)', () => {
  const { sent, send } = collector();
  let calls = 0;
  const server = {
    handleRequest(message) {
      calls += 1;
      if (calls === 1) throw new Error('boom');
      return { jsonrpc: '2.0', id: message.id, result: { ok: true } };
    },
  };

  handleStdioLine('{"jsonrpc":"2.0","id":1,"method":"tools/call"}', { server, send, onShutdown: () => {} });
  handleStdioLine('{"jsonrpc":"2.0","id":2,"method":"tools/list"}', { server, send, onShutdown: () => {} });

  assert.equal(sent.length, 2);
  assert.equal(sent[0].error.code, -32603);
  assert.deepEqual(sent[1], { jsonrpc: '2.0', id: 2, result: { ok: true } });
});

test('existing behaviour is preserved: parse errors, blank lines, shutdown', () => {
  const { sent, send } = collector();
  const shutdowns = [];
  const server = { handleRequest: message => ({ jsonrpc: '2.0', id: message.id, result: {} }) };
  const io = { server, send, onShutdown: () => shutdowns.push(true) };

  handleStdioLine('   ', io);
  handleStdioLine('', io);
  assert.equal(sent.length, 0, 'blank lines produce no output');

  handleStdioLine('not json', io);
  assert.equal(sent[0].error.code, -32700);

  handleStdioLine('{"jsonrpc":"2.0","id":9,"method":"shutdown"}', io);
  assert.equal(shutdowns.length, 1);
});

test('a throwing shutdown request does not trigger the shutdown path (#414)', () => {
  const { sent, send } = collector();
  const shutdowns = [];
  handleStdioLine('{"jsonrpc":"2.0","id":1,"method":"shutdown"}', {
    server: throwingServer(new Error('boom')),
    send,
    onShutdown: () => shutdowns.push(true),
  });
  assert.equal(sent[0].error.code, -32603);
  assert.equal(shutdowns.length, 0);
});
