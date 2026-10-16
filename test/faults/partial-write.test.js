'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { readExternalActionReceiptsWithErrors } = require('../../lib/external-action-receipt-reader');
const { spawnFixture, tempDir, waitForExit, waitForLine } = require('./helpers');

test('partial append after process kill preserves earlier receipts and reports the torn tail', async (t) => {
  const root = tempDir(t, 'huqan-fault-partial-write-');
  const receiptPath = path.join(root, 'receipts.jsonl');
  fs.writeFileSync(receiptPath, JSON.stringify({ receiptId: 'stable', status: 'admitted' }) + '\n');

  const child = spawnFixture('partial-write-child.cjs', [receiptPath]);
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  });

  await waitForLine(child);
  assert.equal(child.kill('SIGKILL'), true);
  await waitForExit(child);

  const afterCrash = readExternalActionReceiptsWithErrors({ path: receiptPath });
  assert.deepEqual(afterCrash.receipts.map((item) => item.receiptId), ['stable']);
  assert.equal(afterCrash.unreadableLines, 1);

  fs.appendFileSync(receiptPath, '\n' + JSON.stringify({ receiptId: 'recovered', status: 'executed' }) + '\n');
  const recovered = readExternalActionReceiptsWithErrors({ path: receiptPath });
  assert.deepEqual(recovered.receipts.map((item) => item.receiptId), ['stable', 'recovered']);
  assert.equal(recovered.unreadableLines, 1);
});
