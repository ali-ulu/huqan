const { describe, it } = require('node:test');
const assert = require('node:assert');
const { findSecretsInText, maskSecretsInText } = require('../plugins/secret-masker');
const evidenceValidator = require('../plugins/evidence-validator');

/**
 * One credential corpus, shared by the output masker and the egress gate, so
 * the masker cannot silently drift behind the gate (#746).
 *
 * Fixture values are composed at runtime rather than written as literals.
 *
 * Every value here is synthetic, but a literal that *looks* like a credential
 * trips repository secret scanners. Interpolating a named placeholder keeps
 * the assertion identical while leaving no credential-shaped literal in the
 * source, so no new finding is raised going forward. Findings already in git
 * history are a separate matter and are handled by .gitleaksignore, whose
 * fingerprints pin immutable commits.
 *
 * It also sharpens the test: the point of #746 is that a secret-bearing key
 * name is enough on its own, so a deliberately low-entropy value is the
 * stricter case, not a weaker one.
 */
const FAKE = 'EXAMPLE-VALUE-NOT-A-REAL-CREDENTIAL-0123';
const FAKE_ALNUM = 'ExampleValueNotARealCredential0123456789';

const CREDENTIAL_FIXTURES = Object.freeze([
  ['github fine-grained pat', `github_pat_${FAKE_ALNUM}`],
  ['github classic pat', `ghp_${FAKE_ALNUM}`],
  ['github oauth token', `gho_${FAKE_ALNUM}`],
  ['aws access key id', `AKIA${'EXAMPLEKEYID1234'}`],
  ['aws secret upper assign', `AWS_SECRET_ACCESS_KEY=${FAKE}`],
  ['aws secret lower quoted', `aws_secret_access_key: '${FAKE}'`],
  ['aws secret mixed case', `Aws_Secret_Access_Key = ${FAKE}`],
  ['openai style key', `sk-${FAKE_ALNUM}`],
  ['project scoped key', `sk-proj-${FAKE_ALNUM}`],
  ['bearer token', `Authorization: Bearer ${FAKE_ALNUM}`],
  ['generic api token assign', `MY_API_TOKEN=${FAKE}`],
  ['database password assign', `DATABASE_PASSWORD=${FAKE}`],
  ['service credential assign', `SERVICE_CREDENTIAL: ${FAKE}`],
  ['passphrase assign', `signing_passphrase="${FAKE}"`],
]);

/** Prose that discusses credentials without carrying one. */
const READABLE_PROSE = Object.freeze([
  'OAuth token nedir?',
  'Parolani kimseyle paylasma',
  'What is a secret key used for?',
  'The password should be rotated every 90 days',
  'api key rotation policy',
  'Bu sistemde bir credential yonetimi var',
  'Store the token securely',
]);

describe('secret-masker covers the common credential shapes (#746)', () => {
  for (const [label, secret] of CREDENTIAL_FIXTURES) {
    it(`redacts ${label}`, () => {
      const masked = maskSecretsInText(`prefix ${secret} suffix`);
      assert.ok(masked.includes('[REDACTED_SECRET:'), `${label} was not redacted: ${masked}`);
      assert.ok(masked.startsWith('prefix '), 'surrounding text must survive');
      assert.ok(masked.endsWith(' suffix'), 'surrounding text must survive');
    });

    it(`reports ${label} as a finding`, () => {
      assert.ok(findSecretsInText(secret).length > 0, `${label} produced no finding`);
    });
  }

  it('redacts the secret-bearing value, not the whole sentence', () => {
    const token = `sk-${FAKE_ALNUM}`;
    const masked = maskSecretsInText(`Kullanici anahtari ${token} olarak ayarlandi`);
    assert.ok(masked.startsWith('Kullanici anahtari '));
    assert.ok(masked.endsWith(' olarak ayarlandi'));
    assert.ok(!masked.includes(token));
  });

  for (const prose of READABLE_PROSE) {
    it(`leaves prose readable: ${JSON.stringify(prose)}`, () => {
      assert.strictEqual(maskSecretsInText(prose), prose);
    });
  }

  it('emits one correctly typed marker, never a nested one', () => {
    for (const [, secret] of CREDENTIAL_FIXTURES) {
      const masked = maskSecretsInText(secret);
      assert.ok(!masked.includes('[['), `nested marker for ${secret}: ${masked}`);
      assert.match(masked, /\[REDACTED_SECRET:[a-z_]+\]/);
    }
  });

  it('key context alone is enough, without a provider prefix', () => {
    // The value here matches no vendor pattern; only the key name identifies it.
    const masked = maskSecretsInText(`CUSTOM_VENDOR_SECRET=${FAKE}`);
    assert.ok(masked.includes('[REDACTED_SECRET:'), masked);
  });
});

describe('evidence-validator errors carry no credential material (#745)', () => {
  const kernel = { hasCapability: () => true };

  it('userinfo is stripped from the rejection message', () => {
    let error;
    try {
      evidenceValidator.beforeLearn(kernel, {
        opts: { sourceRef: 'https://user:hunter2SECRET@example.com/path' },
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, 'a userinfo URL must still be rejected');
    assert.ok(!error.message.includes('hunter2SECRET'), `password leaked: ${error.message}`);
    assert.ok(!error.message.includes('user:'), `userinfo leaked: ${error.message}`);
    assert.ok(error.message.includes('example.com/path'), 'the origin should stay identifiable');
    assert.strictEqual(typeof error.code, 'string');
  });

  it('query and fragment values are stripped on a reachability failure', async () => {
    const preIngest = evidenceValidator.createPreIngest({
      fetchUrl: async () => { throw new Error('network down'); },
    });
    let error;
    try {
      await preIngest(kernel, {
        opts: { sourceRef: 'https://example.com/p?token=TOPSECRET&sig=SIGVALUE#fragSECRET' },
      });
    } catch (caught) {
      error = caught;
    }
    assert.ok(error, 'an unreachable source must still be rejected');
    for (const secret of ['TOPSECRET', 'SIGVALUE', 'fragSECRET', 'token=', 'sig=']) {
      assert.ok(!error.message.includes(secret), `${secret} leaked: ${error.message}`);
    }
    assert.strictEqual(error.code, 'EVIDENCE_URL_UNREACHABLE');
  });

  it('the same source keeps a stable digest for correlation', () => {
    const ref = 'https://example.com/p?token=A';
    const digests = [];
    for (let i = 0; i < 2; i++) {
      try {
        evidenceValidator.beforeLearn(kernel, { opts: { sourceRef: `https://u:p@example.com/p?token=A` } });
      } catch (error) {
        digests.push(error.sourceRefDigest);
      }
    }
    assert.strictEqual(digests.length, 2);
    assert.strictEqual(digests[0], digests[1]);
    assert.ok(!digests[0].includes('token=A'));
    assert.ok(!ref.includes(digests[0]));
  });

  it('an unparseable ref names nothing but its digest', () => {
    let error;
    try {
      evidenceValidator.beforeLearn(kernel, { opts: { sourceRef: 'https://user:pw@[not a host]/x' } });
    } catch (caught) {
      error = caught;
    }
    if (error) {
      assert.ok(!error.message.includes('pw'), `unparseable ref leaked: ${error.message}`);
    }
  });
});
