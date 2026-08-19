'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
const delegateSource = fs.readFileSync(path.join(__dirname, '..', 'lib', 'graph-mutation-receipt-read.js'), 'utf8');

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: mutation receipt lookups are one-line delegations', () => {
  assert.equal(
    methodBody(graphSource, 'getCommittedMutationReceiptByOperation'),
    'return runReceiptByOperationRead(this._mutationReceiptReadStoreApi(), operationId);',
  );
  assert.equal(
    methodBody(graphSource, 'getCommittedMutationReceiptById'),
    'return runReceiptByIdRead(this._mutationReceiptReadStoreApi(), receiptId);',
  );
});

test('GRAPH: mutation receipt delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(['"]\.\.\/graph['"]\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /_db|_stmts|_readJsonJournal/);
  assert.match(delegateSource, /module\.exports = \{/);
});

test('GRAPH: mutation receipt delegate preserves SQLite and JSON canonical shapes', () => {
  const {
    getCommittedMutationReceiptByOperation,
    getCommittedMutationReceiptById,
  } = require('../lib/graph-mutation-receipt-read');
  const sqliteRow = {
    operation_id: 'op-1',
    receipt_id: 'rcpt-1',
    workspace_id: 'ws-1',
    canonical_payload: '{"action":"learn"}',
    previous_receipt_hash: 'prev',
    receipt_hash: 'head',
    committed_at: '2026-08-19T00:00:00.000Z',
  };
  const expected = {
    operationId: 'op-1',
    receiptId: 'rcpt-1',
    workspaceId: 'ws-1',
    canonicalPayload: { action: 'learn' },
    previousReceiptHash: 'prev',
    receiptHash: 'head',
    committedAt: '2026-08-19T00:00:00.000Z',
  };
  const sqliteApi = {
    hasSqlite: () => true,
    getMutationReceiptByOperation: () => sqliteRow,
    getMutationReceiptById: () => sqliteRow,
    readJsonJournal: () => { throw new Error('JSON journal must not be read'); },
  };
  assert.deepEqual(getCommittedMutationReceiptByOperation(sqliteApi, 'op-1'), expected);
  assert.deepEqual(getCommittedMutationReceiptById(sqliteApi, 'rcpt-1'), expected);
  assert.equal(getCommittedMutationReceiptByOperation({ ...sqliteApi, getMutationReceiptByOperation: () => null }, 'missing'), null);

  const jsonRow = {
    receiptId: 'rcpt-2',
    workspaceId: 'ws-2',
    canonicalPayload: { action: 'ask' },
    previousReceiptHash: null,
    receiptHash: 'head-2',
    committedAt: '2026-08-19T00:01:00.000Z',
  };
  const journalApi = {
    hasSqlite: () => false,
    getMutationReceiptByOperation: () => { throw new Error('SQLite must not be read'); },
    getMutationReceiptById: () => { throw new Error('SQLite must not be read'); },
    readJsonJournal: () => ({
      receipts: { 'op-2': jsonRow },
      receiptsById: { 'rcpt-2': 'op-2' },
    }),
  };
  assert.deepEqual(getCommittedMutationReceiptByOperation(journalApi, 'op-2'), { operationId: 'op-2', ...jsonRow });
  assert.deepEqual(getCommittedMutationReceiptById(journalApi, 'rcpt-2'), { operationId: 'op-2', ...jsonRow });
  assert.equal(getCommittedMutationReceiptById(journalApi, 'missing'), null);
});

test('GRAPH: unreadable JSON journal remains fail-closed', () => {
  const { getCommittedMutationReceiptByOperation } = require('../lib/graph-mutation-receipt-read');
  const error = new Error('journal unreadable');
  assert.throws(
    () => getCommittedMutationReceiptByOperation({ hasSqlite: () => false, readJsonJournal: () => { throw error; } }, 'op-1'),
    error,
  );
});
