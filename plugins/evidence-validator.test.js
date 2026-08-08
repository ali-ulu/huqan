const test = require('node:test');
const assert = require('node:assert/strict');

const evidenceValidator = require('./evidence-validator');
const { validateSourceUrl } = evidenceValidator;
const Kernel = require('../kernel');

test('evidence-validator: accepts an ordinary https URL', () => {
  assert.deepEqual(validateSourceUrl('https://example.com/report'), { ok: true });
});

test('evidence-validator: rejects a malformed URL', () => {
  const result = validateSourceUrl('https://[not a valid url');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EVIDENCE_URL_MALFORMED');
});

test('evidence-validator: rejects a non-http(s) protocol', () => {
  const result = validateSourceUrl('file:///etc/passwd');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EVIDENCE_URL_PROTOCOL_BLOCKED');
});

test('evidence-validator: rejects userinfo-based host spoofing', () => {
  const result = validateSourceUrl('https://accounts.google.com@evil.example/login');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EVIDENCE_URL_USERINFO_SPOOF');
});

test('evidence-validator: rejects a punycode/IDN hostname as suspected homograph', () => {
  const result = validateSourceUrl('https://xn--80ak6aa92e.com/');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EVIDENCE_URL_HOMOGRAPH_SUSPECTED');
});

test('evidence-validator: an ordinary ASCII multi-label host is not flagged', () => {
  assert.deepEqual(validateSourceUrl('https://docs.example.co.uk/page'), { ok: true });
});

test('evidence-validator: beforeLearn ignores non-URL sourceRef shapes (file:, git:, absent)', () => {
  const passthroughFile = evidenceValidator.beforeLearn(null, { text: 'x', opts: { sourceRef: 'file:/tmp/a.md' } });
  assert.equal(passthroughFile.opts.sourceRef, 'file:/tmp/a.md');

  const passthroughGit = evidenceValidator.beforeLearn(null, { text: 'x', opts: { sourceRef: 'git:/repo:abc123' } });
  assert.equal(passthroughGit.opts.sourceRef, 'git:/repo:abc123');

  const passthroughNone = evidenceValidator.beforeLearn(null, { text: 'x', opts: {} });
  assert.equal(passthroughNone.text, 'x');
});

test('evidence-validator: beforeLearn throws for a spoofed http(s) sourceRef', () => {
  assert.throws(
    () => evidenceValidator.beforeLearn(null, {
      text: 'x',
      opts: { sourceRef: 'https://accounts.google.com@evil.example/login' },
    }),
    (err) => err.code === 'EVIDENCE_URL_USERINFO_SPOOF'
  );
});

test('evidence-validator: beforeLearn end to end -- kernel.learn() itself rejects a spoofed sourceRef', () => {
  const k = new Kernel({ noLoad: true });
  k.plugins.register(evidenceValidator);

  assert.throws(
    () => k.learn('Köpek hayvandır', {
      ...Kernel.createAdmissionBypassOpts('test'),
      sourceRef: 'https://accounts.google.com@evil.example/login',
    }),
    (err) => err.code === 'EVIDENCE_URL_USERINFO_SPOOF'
  );
  assert.ok(!k.graph.getNode('köpek'), 'the rejected claim must not reach the graph');

  // An ordinary, non-spoofed sourceRef still learns normally.
  k.learn('Kedi hayvandır', {
    ...Kernel.createAdmissionBypassOpts('test'),
    sourceRef: 'https://example.com/report',
  });
  assert.ok(k.graph.getNode('kedi'), 'a legitimate sourceRef must still be learnable');
});

// --- #348: async reachability gate (preIngest) ---

const stubFetch = (result) => async () => {
  if (result instanceof Error) throw result;
  return result;
};

const reachabilityKernel = () => {
  // loadPlugins:false so the on-disk evidence-validator does not claim the
  // name first and make register() dedupe away the fetch-injected copy.
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  k.enableCapability('evidenceReachability');
  return k;
};

test('evidence-validator: checkSourceReachable accepts a 200 response', async () => {
  const result = await evidenceValidator.checkSourceReachable('https://example.com/a', {
    fetchUrl: stubFetch({ statusCode: 200 }),
  });
  assert.deepEqual(result, { ok: true });
});

test('evidence-validator: checkSourceReachable rejects 404 and 403', async () => {
  for (const statusCode of [403, 404]) {
    const result = await evidenceValidator.checkSourceReachable('https://example.com/a', {
      fetchUrl: stubFetch({ statusCode }),
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'EVIDENCE_URL_UNREACHABLE');
    assert.match(result.reason, new RegExp(String(statusCode)));
  }
});

test('evidence-validator: checkSourceReachable is fail-closed on a network error', async () => {
  const result = await evidenceValidator.checkSourceReachable('https://example.com/a', {
    fetchUrl: stubFetch(Object.assign(new Error('getaddrinfo ENOTFOUND'), { code: 'ENOTFOUND' })),
  });
  assert.equal(result.ok, false);
  assert.equal(result.code, 'EVIDENCE_URL_UNREACHABLE');
});

test('evidence-validator: a server refusing HEAD (405/501) is inconclusive, not a rejection', async () => {
  for (const statusCode of [405, 501]) {
    const result = await evidenceValidator.checkSourceReachable('https://example.com/a', {
      fetchUrl: stubFetch({ statusCode }),
    });
    assert.deepEqual(result, { ok: true }, `HTTP ${statusCode} must pass`);
  }
});

test('evidence-validator: preIngest probes with HEAD and a bounded timeout', async () => {
  const calls = [];
  const preIngest = evidenceValidator.createPreIngest({
    fetchUrl: async (url, options) => { calls.push({ url, options }); return { statusCode: 200 }; },
  });
  await preIngest(reachabilityKernel(), { text: 'x', opts: { sourceRef: 'https://example.com/a' } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.com/a');
  assert.equal(calls[0].options.method, 'HEAD');
  assert.ok(calls[0].options.timeoutMs > 0, 'probe must be time-bounded');
});

test('evidence-validator: preIngest does not touch the network when the capability is off', async () => {
  let called = false;
  const preIngest = evidenceValidator.createPreIngest({
    fetchUrl: async () => { called = true; return { statusCode: 200 }; },
  });
  const k = new Kernel({ noLoad: true, loadPlugins: false });
  assert.equal(k.hasCapability('evidenceReachability'), false, 'gate must be off by default');

  const passthrough = await preIngest(k, { text: 'x', opts: { sourceRef: 'https://example.com/a' } });
  assert.equal(called, false);
  assert.equal(passthrough.text, 'x');
});

test('evidence-validator: preIngest rejects a malformed URL without spending a request', async () => {
  let called = false;
  const preIngest = evidenceValidator.createPreIngest({
    fetchUrl: async () => { called = true; return { statusCode: 200 }; },
  });
  await assert.rejects(
    () => preIngest(reachabilityKernel(), { text: 'x', opts: { sourceRef: 'https://accounts.google.com@evil.example/' } }),
    (err) => err.code === 'EVIDENCE_URL_USERINFO_SPOOF'
  );
  assert.equal(called, false, 'shape rejection must short-circuit before the probe');
});

test('evidence-validator: preIngest ignores non-http sourceRef shapes', async () => {
  let called = false;
  const preIngest = evidenceValidator.createPreIngest({
    fetchUrl: async () => { called = true; return { statusCode: 200 }; },
  });
  const passthrough = await preIngest(reachabilityKernel(), { text: 'x', opts: { sourceRef: 'git:/repo:abc123' } });
  assert.equal(called, false);
  assert.equal(passthrough.opts.sourceRef, 'git:/repo:abc123');
});

test('evidence-validator: end to end -- learnAsync() rejects an unreachable sourceRef, learn() is unaffected', async () => {
  const k = reachabilityKernel();
  k.plugins.register({
    ...evidenceValidator,
    preIngest: evidenceValidator.createPreIngest({ fetchUrl: stubFetch({ statusCode: 404 }) }),
  });

  await assert.rejects(
    () => k.learnAsync('Köpek hayvandır', {
      ...Kernel.createAdmissionBypassOpts('test'),
      sourceRef: 'https://example.com/gone',
    }),
    (err) => err.code === 'EVIDENCE_URL_UNREACHABLE'
  );
  assert.ok(!k.graph.getNode('köpek'), 'the unreachable-evidence claim must not reach the graph');

  // The synchronous path has no opinion on reachability -- that is the
  // whole point of keeping the async work out of beforeLearn (#348).
  k.learn('Kedi hayvandır', {
    ...Kernel.createAdmissionBypassOpts('test'),
    sourceRef: 'https://example.com/gone',
  });
  assert.ok(k.graph.getNode('kedi'), 'sync learn() must stay reachability-agnostic');
});

test('evidence-validator: learnAsync() learns normally when the source is reachable', async () => {
  const k = reachabilityKernel();
  k.plugins.register({
    ...evidenceValidator,
    preIngest: evidenceValidator.createPreIngest({ fetchUrl: stubFetch({ statusCode: 200 }) }),
  });

  const result = await k.learnAsync('Kedi hayvandır', {
    ...Kernel.createAdmissionBypassOpts('test'),
    sourceRef: 'https://example.com/report',
  });
  assert.ok(result?.data?.learned > 0, 'a reachable source must learn');
  assert.ok(k.graph.getNode('kedi'));
});
