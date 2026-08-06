const test = require('node:test');
const assert = require('node:assert/strict');

const { isPrivateIpv4, isPrivateIpv6, isPrivateAddress, resolveSafeAddress } = require('./ssrf-guard');

test('ssrf-guard: isPrivateIpv4 flags loopback, private, link-local, CGNAT, and reserved ranges', () => {
  const privateOnes = [
    '127.0.0.1', '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255',
    '192.168.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '192.0.2.1',
    '198.51.100.1', '203.0.113.1', '224.0.0.1', '255.255.255.255',
  ];
  for (const ip of privateOnes) {
    assert.equal(isPrivateIpv4(ip), true, `${ip} should be private`);
  }
});

test('ssrf-guard: isPrivateIpv4 allows ordinary public addresses', () => {
  const publicOnes = ['8.8.8.8', '1.1.1.1', '93.184.216.34', '172.15.0.1', '172.32.0.1', '169.253.0.1'];
  for (const ip of publicOnes) {
    assert.equal(isPrivateIpv4(ip), false, `${ip} should be public`);
  }
});

test('ssrf-guard: isPrivateIpv4 fails closed on malformed input', () => {
  assert.equal(isPrivateIpv4('not-an-ip'), true);
  assert.equal(isPrivateIpv4('999.1.1.1'), true);
});

test('ssrf-guard: isPrivateIpv6 flags loopback, unique-local, link-local, and mapped-private-IPv4', () => {
  assert.equal(isPrivateIpv6('::1'), true);
  assert.equal(isPrivateIpv6('::'), true);
  assert.equal(isPrivateIpv6('fc00::1'), true);
  assert.equal(isPrivateIpv6('fd12:3456::1'), true);
  assert.equal(isPrivateIpv6('fe80::1'), true);
  assert.equal(isPrivateIpv6('::ffff:127.0.0.1'), true);
  assert.equal(isPrivateIpv6('::ffff:10.0.0.1'), true);
});

test('ssrf-guard: isPrivateIpv6 allows an ordinary public IPv6 address', () => {
  assert.equal(isPrivateIpv6('2606:4700:4700::1111'), false);
});

test('ssrf-guard: isPrivateAddress fails closed on unrecognizable input', () => {
  assert.equal(isPrivateAddress('garbage'), true);
});

test('ssrf-guard: resolveSafeAddress rejects non-http(s) protocols', async () => {
  await assert.rejects(
    () => resolveSafeAddress('file:///etc/passwd'),
    (err) => err.code === 'SSRF_PROTOCOL_BLOCKED'
  );
  await assert.rejects(
    () => resolveSafeAddress('ftp://example.com/file'),
    (err) => err.code === 'SSRF_PROTOCOL_BLOCKED'
  );
});

test('ssrf-guard: resolveSafeAddress rejects an invalid URL', async () => {
  await assert.rejects(
    () => resolveSafeAddress('not a url'),
    (err) => err.code === 'SSRF_INVALID_URL'
  );
});

test('ssrf-guard: resolveSafeAddress rejects blocked hostname literals without a DNS lookup', async () => {
  let lookupCalled = false;
  await assert.rejects(
    () => resolveSafeAddress('http://localhost:8080/', {
      lookupImpl: async () => { lookupCalled = true; return [{ address: '8.8.8.8', family: 4 }]; },
    }),
    (err) => err.code === 'SSRF_HOSTNAME_BLOCKED'
  );
  assert.equal(lookupCalled, false);
});

test('ssrf-guard: resolveSafeAddress rejects when any resolved address is private (DNS-rebinding shape)', async () => {
  await assert.rejects(
    () => resolveSafeAddress('http://attacker.example/', {
      lookupImpl: async () => [
        { address: '8.8.8.8', family: 4 },
        { address: '169.254.169.254', family: 4 }, // decoy public address first, real target second
      ],
    }),
    (err) => err.code === 'SSRF_PRIVATE_ADDRESS_BLOCKED'
  );
});

test('ssrf-guard: resolveSafeAddress surfaces DNS failures with a stable error code', async () => {
  await assert.rejects(
    () => resolveSafeAddress('http://nonexistent.example/', {
      lookupImpl: async () => { throw new Error('ENOTFOUND'); },
    }),
    (err) => err.code === 'SSRF_DNS_FAILED'
  );
});

test('ssrf-guard: allowPrivateAddresses is a test-only bypass, off by default', async () => {
  const result = await resolveSafeAddress('http://internal.example/', {
    lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
    allowPrivateAddresses: true,
  });
  assert.deepEqual(result.addresses, ['127.0.0.1']);

  await assert.rejects(
    () => resolveSafeAddress('http://internal.example/', {
      lookupImpl: async () => [{ address: '127.0.0.1', family: 4 }],
    }),
    (err) => err.code === 'SSRF_PRIVATE_ADDRESS_BLOCKED'
  );
});

test('ssrf-guard: resolveSafeAddress returns the validated addresses on success', async () => {
  const result = await resolveSafeAddress('https://example.com/path', {
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
  });
  assert.equal(result.hostname, 'example.com');
  assert.deepEqual(result.addresses, ['93.184.216.34']);
  assert.equal(result.family, 4);
});
