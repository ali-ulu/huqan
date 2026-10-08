'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { adaptNliRows } = require('../scripts/semantic-nli-adapter');
const options = { sourceId: 'snli', sourceVersion: '1.0' };
test('gold adapter keeps one teacher and label-blind premise groups', () => {
  const rows = [{ premise: 'A horse jumps.', hypothesis: 'An animal jumps.', label: 0 },
    { premise: 'A horse jumps.', hypothesis: 'No animal jumps.', label: 2 }];
  const output = adaptNliRows(rows, options);
  assert.equal(output.teachers[0].distribution.ENTAILMENT, 1);
  assert.equal(output.records[0].split, output.records[1].split);
  assert.equal(new Set(output.teachers.map(t => t.teacherId)).size, 1);
  assert.deepEqual(output.records, adaptNliRows(rows.map(r => ({ ...r, label: 1 })), options).records);
});
test('unknown labels refuse; unadjudicated labels are excluded', () => {
  assert.throws(() => adaptNliRows([{ premise: 'A', hypothesis: 'B', label: 3 }], options), /nli_label_invalid/);
  assert.equal(adaptNliRows([{ premise: 'A', hypothesis: 'B', label: -1 }], options).excluded.length, 1);
});
