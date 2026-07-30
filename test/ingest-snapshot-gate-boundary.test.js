'use strict';

/**
 * INGEST-SNAPSHOT-0 - fail-closed gate boundary contract.
 *
 * `/api/ingest` may queue only `manual` and `decision`. GitHub and markdown
 * are refused with `INGEST_SNAPSHOT_REQUIRED` until INGEST-SNAPSHOT-0 provides
 * immutable source binding (commit SHA or file hash) and replay protection.
 *
 * That refusal lives in exactly one place - `buildIngestApprovalSnapshot()` -
 * and `handleIngest()` deliberately does NOT repeat it. Today the only runtime
 * caller of `handleIngest` is the approval-execution path in server.js, which
 * runs after the gate has already passed, so nothing routes around it. These
 * tests lock that arrangement so the guarantee cannot be lost silently:
 *
 *   - the gate refuses every external source type, including its aliases;
 *   - a refusal carries no payload and no snapshot hash;
 *   - the asymmetry with `handleIngest` is asserted rather than assumed, so
 *     adding a second caller has to confront it.
 *
 * These tests add no runtime behaviour. They fail if the gate is widened,
 * removed, or bypassed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildIngestApprovalSnapshot,
  normalizeSourceType,
  handleIngest,
} = require('../lib/ingest');

/** Source types that must never reach the approval queue, with their aliases. */
const REFUSED = [
  { input: 'github', canonical: 'github' },
  { input: 'repo', canonical: 'github' },
  { input: 'GitHub', canonical: 'github' },
  { input: 'markdown', canonical: 'markdown' },
  { input: 'MARKDOWN', canonical: 'markdown' },
];

/** Source types the queue accepts today, with their aliases. */
const ACCEPTED = [
  { input: 'manual', canonical: 'manual' },
  { input: 'manuel', canonical: 'manual' },
  { input: 'decision', canonical: 'decision' },
  { input: 'karar', canonical: 'decision' },
];

function sampleDataFor(sourceType) {
  return {
    sourceType,
    // Fields for every branch, so a refusal cannot be blamed on missing input.
    repoUrl: 'https://github.com/ali-ulu/huqan',
    branch: 'main',
    paths: ['README.md'],
    path: 'notes/decision.md',
    rootPath: '/tmp/workspace',
    text: 'ingest gate boundary sample',
    author: 'boundary-test',
    title: 'boundary',
    rationale: 'locking the fail-closed gate',
  };
}

test('alias mapping under test resolves to the canonical source types', () => {
  // Guards the tables above: if aliasing changes, the refusal cases below
  // would silently stop covering github/markdown.
  for (const { input, canonical } of [...REFUSED, ...ACCEPTED]) {
    assert.strictEqual(
      normalizeSourceType(input),
      canonical,
      `${input} must normalize to ${canonical}`
    );
  }
});

test('external ingest sources are refused with INGEST_SNAPSHOT_REQUIRED', () => {
  for (const { input, canonical } of REFUSED) {
    const result = buildIngestApprovalSnapshot(sampleDataFor(input));

    assert.strictEqual(result.ok, false, `${input} must not be queueable`);
    assert.strictEqual(
      result.code,
      'INGEST_SNAPSHOT_REQUIRED',
      `${input} must be refused by the snapshot gate, not by generic validation`
    );
    assert.match(
      result.error,
      /INGEST-SNAPSHOT-0/,
      `${input} refusal must name the gate that would unblock it`
    );
    // A refusal must not hand back anything queueable for the caller to reuse.
    assert.strictEqual(result.payload, undefined, `${canonical} refusal leaked a payload`);
    assert.strictEqual(result.snapshotHash, undefined, `${canonical} refusal leaked a snapshot hash`);
    assert.strictEqual(result.idempotencyKey, undefined, `${canonical} refusal leaked an idempotency key`);
  }
});

test('manual and decision remain queueable with a snapshot hash', () => {
  // Non-vacuity: the refusal test above would also pass if the gate refused
  // everything. This proves the accepted set still works.
  for (const { input, canonical } of ACCEPTED) {
    const result = buildIngestApprovalSnapshot(sampleDataFor(input));

    assert.strictEqual(result.ok, true, `${input} must stay queueable`);
    assert.strictEqual(result.sourceType, canonical);
    assert.ok(result.snapshotHash, `${input} must produce a snapshot hash`);
    // The hash carries its algorithm prefix, so a future migration cannot be
    // mistaken for the same digest. Lock both halves.
    assert.match(
      result.snapshotHash,
      /^sha256:[0-9a-f]{64}$/,
      'snapshot hash must stay algorithm-prefixed sha256 hex'
    );
    assert.ok(result.idempotencyKey, `${input} must produce an idempotency key`);
    assert.strictEqual(result.payload.action, 'ingest');
    assert.strictEqual(result.payload.sourceType, canonical);
  }
});

test('unknown source types are refused by the gate as well', () => {
  // The gate is an allow-list, not a github/markdown deny-list. A source type
  // nobody has considered yet must not fall through into the queue.
  for (const unknown of ['rss', 'email', '', 'MANUAL_ISH', 'decisionx']) {
    const result = buildIngestApprovalSnapshot(sampleDataFor(unknown));
    assert.strictEqual(result.ok, false, `${unknown || '<empty>'} must not be queueable`);
    assert.strictEqual(result.code, 'INGEST_SNAPSHOT_REQUIRED');
  }
});

test('snapshot hash is repeatable and content-sensitive', () => {
  const first = buildIngestApprovalSnapshot({ sourceType: 'manual', text: 'same text', author: 'a' });
  const second = buildIngestApprovalSnapshot({ sourceType: 'manual', text: 'same text', author: 'a' });
  const different = buildIngestApprovalSnapshot({ sourceType: 'manual', text: 'other text', author: 'a' });

  assert.strictEqual(
    first.snapshotHash,
    second.snapshotHash,
    'identical content must hash identically, or review cannot bind to execution'
  );
  assert.notStrictEqual(
    first.snapshotHash,
    different.snapshotHash,
    'changed content must change the hash, or the pre-execution check is blind'
  );
});

test('handleIngest does not re-enforce the gate - the asymmetry is deliberate', async () => {
  // Documented boundary, not an endorsement: handleIngest accepts all four
  // source types. It is safe today only because its single runtime caller
  // invokes it after buildIngestApprovalSnapshot has already passed.
  //
  // If this assertion ever fails because handleIngest started refusing
  // github, that is an improvement - delete this test and tighten the note in
  // docs/current-operating-roadmap.md. If instead a NEW caller of handleIngest
  // appears that does not go through the gate, this test is the reminder that
  // it must.
  const kernel = {
    async runCapability(name, payload) {
      return { ok: true, echo: name, sourceType: payload.sourceType };
    },
  };

  const result = await handleIngest({
    kernel,
    data: { sourceType: 'github', repoUrl: 'https://github.com/ali-ulu/huqan', branch: 'main' },
    ensureRuntime: () => {},
  });

  assert.notStrictEqual(
    result.code,
    'INGEST_SNAPSHOT_REQUIRED',
    'handleIngest is not the gate; the gate is buildIngestApprovalSnapshot'
  );
  assert.strictEqual(result.ingestMeta.sourceType, 'github');
});
