'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const graphSource = fs.readFileSync(path.join(__dirname, '..', 'graph.js'), 'utf8');
const delegateSource = fs.readFileSync(
  path.join(__dirname, '..', 'lib', 'graph-mutation-receipt-schema.js'),
  'utf8',
);

function methodBody(source, methodName) {
  const start = source.indexOf(`  ${methodName}(`);
  assert.notEqual(start, -1, `${methodName} must remain on Graph`);
  const bodyStart = source.indexOf(') {', start) + 2;
  assert.notEqual(bodyStart, 1, `${methodName} signature must be bounded`);
  const end = source.indexOf('\n  }', bodyStart);
  assert.notEqual(end, -1, `${methodName} body must be bounded`);
  return source.slice(bodyStart + 1, end).trim();
}

test('GRAPH: mutation receipt schema is a one-line delegation', () => {
  assert.equal(
    methodBody(graphSource, '_ensureMutationReceiptFamilySchema'),
    'return runMutationReceiptFamilySchema(this._db);',
  );
});

test('GRAPH: mutation receipt schema delegate is narrow and cycle-free', () => {
  assert.doesNotMatch(delegateSource, /graph\.js/);
  assert.doesNotMatch(delegateSource, /require\(['"]\.\.\/graph['"]\)/);
  assert.doesNotMatch(delegateSource, /this\._/);
  assert.doesNotMatch(delegateSource, /class\s+Graph/);
  assert.match(delegateSource, /module\.exports = \{/);
});

test('GRAPH: schema delegate backfills the family and verifies the canonical index', () => {
  const { ensureMutationReceiptFamilySchema } = require('../lib/graph-mutation-receipt-schema');
  const calls = [];
  const rows = [{
    sequence: 1,
    canonical_payload: JSON.stringify({ schemaVersion: 'v4-receipt-v1' }),
    receipt_family: 'v4',
  }];
  const db = {
    prepare(sql) {
      calls.push(`prepare:${sql}`);
      if (sql.includes('PRAGMA table_info')) return { all: () => [] };
      if (sql.includes('SELECT sequence, canonical_payload FROM')) {
        return { all: () => rows.map(({ receipt_family: _family, ...row }) => row) };
      }
      if (sql.includes('UPDATE mutation_receipts')) return { run: () => ({ changes: 1 }) };
      if (sql.includes('SELECT sequence, canonical_payload, receipt_family')) {
        return { all: () => rows };
      }
      if (sql.includes('PRAGMA index_info')) {
        return { all: () => [
          { name: 'workspace_id' },
          { name: 'receipt_family' },
          { name: 'sequence' },
        ] };
      }
      throw new Error(`unexpected prepare: ${sql}`);
    },
    exec(sql) {
      calls.push(`exec:${sql}`);
    },
    transaction(callback) {
      calls.push('transaction');
      return () => callback();
    },
  };

  assert.doesNotThrow(() => ensureMutationReceiptFamilySchema(db));
  assert.ok(calls.includes('transaction'));
  assert.ok(calls.some(call => call.includes('ALTER TABLE mutation_receipts ADD COLUMN receipt_family')));
  assert.ok(calls.some(call => call.includes('CREATE INDEX IF NOT EXISTS idx_mutation_receipts_workspace_family_sequence')));
});

test('GRAPH: invalid existing family data fails closed with the migration error code', () => {
  const { ensureMutationReceiptFamilySchema } = require('../lib/graph-mutation-receipt-schema');
  const db = {
    prepare(sql) {
      if (sql.includes('PRAGMA table_info')) return { all: () => [{ name: 'receipt_family', notnull: 1 }] };
      if (sql.includes('SELECT sequence, canonical_payload, receipt_family')) {
        return {
          all: () => [{
            sequence: 7,
            canonical_payload: JSON.stringify({ schemaVersion: 'v4-receipt-v1' }),
            receipt_family: 'non-v4',
          }],
        };
      }
      if (sql.includes('PRAGMA index_info')) return { all: () => [] };
      throw new Error(`unexpected prepare: ${sql}`);
    },
    exec() {
      throw new Error('index creation must not be reached after invalid data');
    },
  };

  assert.throws(
    () => ensureMutationReceiptFamilySchema(db),
    (error) => error.code === 'RECEIPT_FAMILY_MIGRATION_FAILED'
      && error.cause?.message === 'invalid mutation receipt family at sequence 7',
  );
});
