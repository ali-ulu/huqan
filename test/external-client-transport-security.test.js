'use strict';

/**
 * #1672: the standalone client must not put its bearer credential on the wire
 * in cleartext.
 *
 * `admit` sends `authorization: Bearer <HUQAN_API_KEY>`. Over plain HTTP to a
 * remote host that header is readable by anything on the path, and the key it
 * carries admits packages under the client's identity. HTTPS is the default;
 * loopback is the single exception, because those requests never reach a
 * network interface.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { spawnSync } = require('child_process');

const { assertTransportSecurity, isLoopbackHost, parseEndpoint } = require('../scripts/external-client');

const CLIENT = path.join(__dirname, '..', 'scripts', 'external-client.js');

function check(url) {
  assertTransportSecurity(parseEndpoint(url));
}

const ALLOWED = [
  'https://huqan.example.com/api/external-client/packages/admit',
  'https://192.0.2.10:8443/admit',
  'http://127.0.0.1:3000/admit',
  'http://127.0.0.1/admit',
  'http://127.5.6.7:9000/admit',
  'http://localhost:3000/admit',
  'http://LOCALHOST:3000/admit',
  'http://[::1]:3000/admit',
  'https://localhost:3000/admit',
];

for (const url of ALLOWED) {
  test(`${url} is accepted`, () => {
    assert.doesNotThrow(() => check(url));
  });
}

const REJECTED = [
  'http://huqan.example.com/admit',
  'http://192.0.2.10/admit',
  'http://10.0.0.5:3000/admit',
  // Hostnames that merely start or end with a loopback-looking label.
  'http://127.0.0.1.attacker.example/admit',
  'http://localhost.attacker.example/admit',
  'http://notlocalhost/admit',
  // 128.0.0.1 is a routable address one bit away from the loopback block.
  'http://128.0.0.1/admit',
  'http://0.0.0.0:3000/admit',
];

for (const url of REJECTED) {
  test(`${url} is refused`, () => {
    assert.throws(() => check(url), /cleartext HTTP/);
  });
}

test('non-HTTP protocols are refused before the loopback check', () => {
  assert.throws(() => check('ftp://127.0.0.1/admit'), /must be http or https/);
  assert.throws(() => check('file:///etc/passwd'), /must be http or https/);
});

test('a malformed URL fails with a legible error, not a TypeError', () => {
  assert.throws(() => parseEndpoint('not a url'), /not a valid absolute URL/);
  assert.throws(() => parseEndpoint('/api/admit'), /not a valid absolute URL/);
});

test('loopback detection covers the whole 127.0.0.0/8 block and IPv6 forms', () => {
  for (const host of ['127.0.0.1', '127.255.255.254', 'localhost', '::1', '[::1]', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackHost(host), true, `${host} should be loopback`);
  }
  for (const host of ['126.0.0.1', '128.0.0.1', '1270.0.0.1', '127.0.0.256', 'example.com', '::2', '']) {
    assert.equal(isLoopbackHost(host), false, `${host} should not be loopback`);
  }
});

test('the CLI fails closed on a cleartext remote endpoint without reading the credential', () => {
  const result = spawnSync(process.execPath, [
    CLIENT, 'admit',
    '--url', 'http://huqan.example.com/admit',
    '--input', 'missing-input.json',
    '--output', 'missing-output.json',
  ], { encoding: 'utf8', env: { ...process.env, HUQAN_API_KEY: '' } });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /cleartext HTTP/);
  // The URL check runs before readApiKey(), so the missing-credential error is
  // not what surfaces here.
  assert.doesNotMatch(result.stderr, /no credential/);
});
