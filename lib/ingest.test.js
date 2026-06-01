const test = require('node:test');
const assert = require('node:assert/strict');
const {
  normalizeSourceType,
  buildSourceRef,
  buildIdempotencyKey,
  buildCapabilityPayload,
  handleIngest,
} = require('./ingest');

test('normalizeSourceType maps aliases into canonical source types', () => {
  assert.strictEqual(normalizeSourceType('repo'), 'github');
  assert.strictEqual(normalizeSourceType('manuel'), 'manual');
  assert.strictEqual(normalizeSourceType('karar'), 'decision');
  assert.strictEqual(normalizeSourceType('markdown'), 'markdown');
});

test('buildSourceRef and buildIdempotencyKey are stable for repo ingest', () => {
  const data = { sourceType: 'repo', repoUrl: 'https://github.com/agiulucom42-del/axiom', branch: 'main', paths: ['README.md'] };
  const ref = buildSourceRef(data, 'github');
  const idempotencyKey = buildIdempotencyKey(data, 'github', ref);
  assert.ok(ref.includes('axiom'));
  assert.strictEqual(typeof idempotencyKey, 'string');
  assert.ok(idempotencyKey.length > 0);
});

test('buildCapabilityPayload normalizes manual ingest fields', () => {
  const payload = buildCapabilityPayload(
    { text: 'Karar notu', author: 'sonfi', date: '2026-06-01' },
    'manual',
    'manual:Karar notu',
    'idem-1',
  );
  assert.strictEqual(payload.sourceType, 'manual');
  assert.strictEqual(payload.sourceRef, 'manual:Karar notu');
  assert.strictEqual(payload.idempotencyKey, 'idem-1');
  assert.strictEqual(payload.author, 'sonfi');
});

test('handleIngest routes repo, manual and decision inputs through the right capabilities', async () => {
  const calls = [];
  let ensured = 0;
  const kernel = {
    async runCapability(name, payload) {
      calls.push({ name, payload });
      return { ok: true, sourceType: payload.sourceType, echo: name };
    },
  };

  const repoResult = await handleIngest({
    kernel,
    data: {
      sourceType: 'repo',
      repoUrl: 'https://github.com/agiulucom42-del/axiom',
      branch: 'main',
      paths: ['README.md'],
    },
    ensureRuntime: () => { ensured += 1; },
  });
  assert.strictEqual(repoResult.ok, true);
  assert.strictEqual(repoResult.echo, 'repoMemory');
  assert.strictEqual(repoResult.ingestMeta.sourceType, 'github');
  assert.strictEqual(calls[0].name, 'repoMemory');
  assert.strictEqual(calls[0].payload.sourceType, 'github');
  assert.ok(calls[0].payload.idempotencyKey);
  assert.strictEqual(ensured, 1);

  const manualResult = await handleIngest({
    kernel,
    data: { sourceType: 'manual', text: 'AXIOM karar notu', author: 'sonfi' },
    ensureRuntime: () => { ensured += 1; },
  });
  assert.strictEqual(manualResult.echo, 'companyBrain');
  assert.strictEqual(calls[1].name, 'companyBrain');
  assert.strictEqual(calls[1].payload.sourceType, 'manual');
  assert.ok(calls[1].payload.sourceRef.includes('AXIOM karar notu'));

  const decisionResult = await handleIngest({
    kernel,
    data: { sourceType: 'decision', title: 'v0.6', rationale: 'Productization' },
    ensureRuntime: () => { ensured += 1; },
  });
  assert.strictEqual(decisionResult.echo, 'companyBrain');
  assert.strictEqual(calls[2].payload.sourceType, 'decision');
  assert.strictEqual(calls[2].payload.title, 'v0.6');

  const unsupported = await handleIngest({
    kernel,
    data: { sourceType: 'rss' },
    ensureRuntime: () => { ensured += 1; },
  });
  assert.strictEqual(unsupported.ok, false);
  assert.match(unsupported.error, /sourceType must be one of/);
});
