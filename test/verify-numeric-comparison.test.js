'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Kernel = require('../kernel');

test('verify numeric comparison rejects ambiguous grouping and unsafe integers (#1100)', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-numeric-'));
  const kernel = new Kernel({ useSQLite: false, memoryPath: path.join(directory, 'memory.json') });
  assert.equal(Boolean(kernel._parseNumericComparison('2 > 1')), true);
  assert.equal(kernel._parseNumericComparison('1,000 > 999'), null);
  assert.equal(kernel._parseNumericComparison('1.000 > 999'), null);
  assert.equal(kernel._parseNumericComparison('9007199254740993 = 9007199254740992'), null);
});
