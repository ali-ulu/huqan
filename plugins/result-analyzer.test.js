const test = require('node:test');
const assert = require('node:assert/strict');

const resultAnalyzer = require('./result-analyzer');
const { classifySignal } = resultAnalyzer._test;

test('classifySignal: matches plain support/reject words', () => {
  assert.equal(classifySignal('this result confirms the hypothesis'), 'support');
  assert.equal(classifySignal('the test failed'), 'reject');
  assert.equal(classifySignal('no clear signal either way'), 'mixed');
});

test('classifySignal: does not match a positive word inside a negated one (#1307)', () => {
  assert.equal(classifySignal('the input was invalid'), 'reject', '"invalid" is itself a reject stem');
  assert.notEqual(classifySignal('this claim is unsupported'), 'support');
  assert.notEqual(classifySignal('the finding is unconfirmed'), 'support');
  assert.notEqual(classifySignal('the report was untrue'), 'support');
  assert.notEqual(classifySignal('the team was overworked'), 'support');
});

test('classifySignal: does not match "pass" inside "passive" or "bypass" (#1325)', () => {
  assert.notEqual(classifySignal('Passive observation only.'), 'support');
  assert.notEqual(classifySignal('The bypass was triggered.'), 'support');
});

test('classifySignal: matches inflected forms (confirms, rejects, failed)', () => {
  assert.equal(classifySignal('the graph confirms this'), 'support');
  assert.equal(classifySignal('the reviewer rejects the claim'), 'reject');
  assert.equal(classifySignal('the build failed'), 'reject');
});

test('classifySignal: "Test failed: output was invalid." is reject, not support (#1325)', () => {
  assert.equal(classifySignal('Test failed: output was invalid.'), 'reject');
});

test('classifySignal: both a reject and support word present is ambiguous -> mixed, not a silent pick (#1325)', () => {
  assert.equal(classifySignal('previously valid, now rejected as broken'), 'mixed');
  assert.equal(classifySignal('The data does not support the hypothesis; reject it.'), 'mixed');
});

test('classifySignal: matches Turkish support/reject stems (#1325)', () => {
  assert.equal(classifySignal('Sonuc gecersiz, hipotez reddedildi.'), 'reject');
  assert.equal(classifySignal('Hipotez basarili sekilde dogrulandi.'), 'support');
});

test('run(): a negative result signals reject, not support', async () => {
  const result = await resultAnalyzer.run(null, { result: 'the hypothesis was invalid' }, {});
  assert.equal(result.ok, true);
  assert.equal(result.data.output.signal, 'reject');
  assert.equal(result.data.output.updatedHypothesis, 'revise');
  assert.equal(result.data.output.nextAction, 'experimentPlanner');
});
