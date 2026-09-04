'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { requireApiKey } = require('../requestGuards');

const ANONYMOUS = { headers: {} };
const DISABLE_VAR = 'HUQAN_DISABLE_API_AUTH';

function withDisableFlag(value, run) {
  const previous = process.env[DISABLE_VAR];
  if (value === undefined) delete process.env[DISABLE_VAR];
  else process.env[DISABLE_VAR] = value;
  try {
    return run();
  } finally {
    if (previous === undefined) delete process.env[DISABLE_VAR];
    else process.env[DISABLE_VAR] = previous;
  }
}

test('an anonymous request is rejected by default', () => {
  withDisableFlag(undefined, () => {
    const result = requireApiKey(ANONYMOUS, 'configured-key');
    assert.equal(result.ok, false);
    assert.equal(result.status, 401);
  });
});

test('an anonymous request is rejected when the opt-out is absent even with no key configured', () => {
  withDisableFlag(undefined, () => {
    assert.equal(requireApiKey(ANONYMOUS, '').ok, false);
  });
});

test('the opt-out admits an anonymous request', () => {
  for (const value of ['true', 'TRUE', '1']) {
    withDisableFlag(value, () => {
      assert.equal(requireApiKey(ANONYMOUS, 'configured-key').ok, true, `value ${value} must disable auth`);
      assert.equal(requireApiKey(ANONYMOUS, '').ok, true, `value ${value} must disable auth without a key`);
    });
  }
});

test('only an explicit affirmative disables auth', () => {
  for (const value of ['false', '0', '', 'yes', 'no', 'maybe']) {
    withDisableFlag(value, () => {
      assert.equal(
        requireApiKey(ANONYMOUS, 'configured-key').ok,
        false,
        `value ${JSON.stringify(value)} must not disable auth`,
      );
    });
  }
});

test('a correct key still authenticates while the opt-out is absent', () => {
  withDisableFlag(undefined, () => {
    const request = { headers: { authorization: 'Bearer configured-key' } };
    assert.equal(requireApiKey(request, 'configured-key').ok, true);
  });
});
