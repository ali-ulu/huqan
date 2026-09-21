'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createJsonlExternalActionReceiptWriter } = require('../../lib/external-action-receipt');
const { tempDir } = require('./helpers');

test('receipt append failure propagates ENOSPC without corrupting the existing trail', (t) => {
  const root = tempDir(t, 'huqan-fault-receipt-');
  const receiptPath = path.join(root, 'receipts.jsonl');
  const existing = JSON.stringify({ receiptId: 'existing', status: 'admitted' }) + '\n';
  fs.writeFileSync(receiptPath, existing, { mode: 0o600 });

  const writer = createJsonlExternalActionReceiptWriter({ path: receiptPath });
  const originalWriteSync = fs.writeSync;
  fs.writeSync = function injectedDiskFull() {
    const error = new Error('fault injection: disk full');
    error.code = 'ENOSPC';
    throw error;
  };

  try {
    assert.throws(
      () => writer.append({ receiptId: 'should-not-land', status: 'executed' }),
      (error) => error?.code === 'ENOSPC',
    );
  } finally {
    fs.writeSync = originalWriteSync;
  }

  assert.equal(fs.readFileSync(receiptPath, 'utf8'), existing);

  writer.append({ receiptId: 'after-recovery', status: 'executed' });
  const lines = fs.readFileSync(receiptPath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.deepEqual(lines.map((line) => line.receiptId), ['existing', 'after-recovery']);
});
