const test = require('node:test');
const assert = require('node:assert/strict');
const tr = require('./lang-tr');

test('Turkish extraction retains a multi-word subject before bir (#1171)', () => {
  assert.deepEqual(tr.extractFacts('Ali Yılmaz bir doktordur'), [
    { subject: 'ali yilmaz', predicate: 'doktordur' },
  ]);
});
