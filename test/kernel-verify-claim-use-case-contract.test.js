const assert = require('node:assert/strict');
const test = require('node:test');

const Kernel = require('../kernel');

function makeKernel(service) {
  const kernel = Object.create(Kernel.prototype);
  kernel._verifyService = service;
  kernel._criticalSection = false;
  kernel._enterCriticalSection = function enter(operation) {
    assert.equal(operation, 'verify');
    assert.equal(this._criticalSection, false);
    this._criticalSection = true;
  };
  kernel._exitCriticalSection = function exit() {
    assert.equal(this._criticalSection, true);
    this._criticalSection = false;
  };
  return kernel;
}

test('Kernel verify delegates once to VerifyService and preserves result identity', () => {
  const expected = Object.freeze({ ok: true, type: 'verify' });
  const calls = [];
  const kernel = makeKernel({
    verify(statement, opts) {
      calls.push([statement, opts]);
      return expected;
    },
  });
  const opts = Object.freeze({ workspaceId: 'workspace-a', domain: 'aviation' });

  const actual = kernel.verify('B737 is aircraft', opts);

  assert.strictEqual(actual, expected);
  assert.deepEqual(calls, [['B737 is aircraft', opts]]);
  assert.equal(kernel._criticalSection, false);
});

test('Kernel verify preserves service error identity and exits its critical section', () => {
  const expectedError = new Error('verify failed');
  const kernel = makeKernel({
    verify() {
      throw expectedError;
    },
  });

  assert.throws(() => kernel.verify('claim'), (error) => error === expectedError);
  assert.equal(kernel._criticalSection, false);
});

test('Kernel verifyAsync preserves the public verify result and rejection identity', async () => {
  const expected = Object.freeze({ ok: true, type: 'verify' });
  const expectedError = new Error('async verify failed');
  const kernel = makeKernel({ verify() { return expected; } });

  assert.strictEqual(await kernel.verifyAsync('claim'), expected);

  kernel._verifyService = { verify() { throw expectedError; } };
  await assert.rejects(kernel.verifyAsync('claim'), (error) => error === expectedError);
  assert.equal(kernel._criticalSection, false);
});

test('Kernel contradiction inspection delegates once without changing arguments', () => {
  const expected = Object.freeze([{ type: 'cycle', node: 'a' }]);
  const calls = [];
  const kernel = makeKernel({
    detectContradictions(subject, workspaceId) {
      calls.push([subject, workspaceId]);
      return expected;
    },
  });

  const actual = kernel.detectContradictions('subject-a', 'workspace-a');

  assert.strictEqual(actual, expected);
  assert.deepEqual(calls, [['subject-a', 'workspace-a']]);
});
