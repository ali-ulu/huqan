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
