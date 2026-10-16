'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { createExternalClientHttpAdapter } = require('../../lib/external-client-http-adapter');

test('network disconnect aborts the request and never reaches the mutation dependency', async () => {
  let admissions = 0;
  const adapter = createExternalClientHttpAdapter({
    admitPackage: async () => {
      admissions += 1;
      throw new Error('must not be reached after disconnect');
    },
  });

  const request = new PassThrough();
  request.method = 'POST';
  request.headers = { 'content-type': 'application/json' };
  const pending = adapter.handle(request);

  queueMicrotask(() => request.emit('aborted'));
  const response = await pending;

  assert.equal(response.statusCode, 400);
  assert.deepEqual(response.body, { ok: false });
  assert.equal(admissions, 0);
});
