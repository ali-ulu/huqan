const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createExternalClientHttpAdapter } = require('../lib/external-client-http-adapter');
const { EXTERNAL_CLIENT_ENDPOINT_PATH } = require('../lib/external-client-endpoint-contract');
const { createRouteHarness } = require('./helpers/external-client-route-harness');

test('external-client body timeout writes HTTP 408 before closing the connection (#719)', async (t) => {
  const harness = await createRouteHarness({
    adapter: createExternalClientHttpAdapter({ admitPackage: async () => {
      throw new Error('must not delegate after timeout');
    } }),
  });
  t.after(() => harness.close());

  const response = await new Promise((resolve, reject) => {
    let settled = false;
    const request = http.request({
      host: '127.0.0.1',
      port: harness.port,
      path: EXTERNAL_CLIENT_ENDPOINT_PATH,
      method: 'POST',
      headers: {
        authorization: `Bearer ${harness.apiKey}`,
        'content-type': 'application/json',
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
      res.on('end', () => {
        settled = true;
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') });
        request.destroy();
      });
    });
    request.once('error', (error) => {
      if (!settled) reject(error);
    });
    request.write('{"package":');
  });

  assert.equal(response.status, 408);
  assert.equal(response.headers.connection, 'close');
  assert.deepEqual(JSON.parse(response.body), { ok: false });
  assert.equal(harness.adapterCalls, 1);
});
