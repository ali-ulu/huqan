'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  ERROR_SCHEMA_VERSION,
  EXCHANGE_ERROR_TYPES,
  TERMINAL_ERROR_TYPES,
  buildExchangeErrorRecord,
  classifyExchangeErrorType,
  isRetryableErrorRecord,
} = require('../lib/a2a/exchange-error-record');
const {
  MAX_DELEGATION_DEPTH,
  evaluateDelegationDepth,
  withinDelegationDepth,
} = require('../lib/a2a/delegation-depth');
const { RETRYABLE_EVALUATOR_REASONS } = require('../lib/a2a/retry-classification');
const { validateDelegation } = require('../lib/a2a/bounded-exchange-validation');
const { buildFixture } = require('../scripts/a2a-conformance/run-fixture');
const { EVALUATION_TIME } = require('../scripts/a2a-conformance/run-support');
const { evaluateBoundedExchange } = require('../lib/a2a/bounded-exchange');

function chainOf(length, prefix = 'agent') {
  return Array.from({ length }, (_, index) => `${prefix}-${index}`);
}

function delegationOf(chain) {
  return { chain, hops: chain.slice(1).map(() => ({})) };
}

test('error record carries exactly the typed triple, never the raw traceback', () => {
  const record = buildExchangeErrorRecord({
    errorType: 'exchange_signature_invalid',
    errorMessage: 'signature mismatch',
    traceback: 'Error: boom\n    at verify (exchange.js:10:5)',
  });
  assert.deepEqual(Object.keys(record).sort(),
    ['error_message', 'error_type', 'schemaVersion', 'traceback_hash']);
  assert.equal(record.schemaVersion, ERROR_SCHEMA_VERSION);
  assert.equal(record.error_type, 'exchange_signature_invalid');
  assert.equal(record.error_message, 'signature mismatch');
  assert.equal(record.traceback_hash,
    crypto.createHash('sha256').update('Error: boom\n    at verify (exchange.js:10:5)', 'utf8').digest('hex'));
  assert.equal(JSON.stringify(record).includes('at verify'), false);
});

test('error record without a traceback carries a null hash', () => {
  const record = buildExchangeErrorRecord({ errorType: 'replay_detected', errorMessage: 'already reserved' });
  assert.equal(record.traceback_hash, null);
  assert.deepEqual(Object.keys(record).sort(),
    ['error_message', 'error_type', 'schemaVersion', 'traceback_hash']);
});

test('error record refuses unknown types and malformed fields before anything is built', () => {
  assert.throws(() => buildExchangeErrorRecord({
    errorType: 'escalated_review', errorMessage: 'x',
  }), /exchange_error_type_unknown/);
  assert.throws(() => buildExchangeErrorRecord({ errorMessage: 'x' }), /exchange_error_type_unknown/);
  assert.throws(() => buildExchangeErrorRecord({ errorType: 'ok', errorMessage: 'x' }), /exchange_error_type_unknown/);
  for (const message of ['', 42, null, 'x'.repeat(1025)]) {
    assert.throws(() => buildExchangeErrorRecord({ errorType: 'replay_detected', errorMessage: message }),
      /exchange_error_message_invalid/);
  }
  assert.throws(() => buildExchangeErrorRecord({
    errorType: 'replay_detected', errorMessage: 'x', traceback: 'y'.repeat(8193),
  }), /exchange_error_traceback_invalid/);
  assert.throws(() => buildExchangeErrorRecord({
    errorType: 'replay_detected', errorMessage: 'x', traceback: 42,
  }), /exchange_error_traceback_invalid/);
});

test('the error type vocabulary is exactly the exchange outcome set', () => {
  assert.deepEqual([...EXCHANGE_ERROR_TYPES], [
    ...RETRYABLE_EVALUATOR_REASONS,
    ...TERMINAL_ERROR_TYPES,
  ]);
  assert.deepEqual([...TERMINAL_ERROR_TYPES], [
    'replay_detected',
    'verification_failed',
    'admission_invalid',
  ]);
  assert.equal(MAX_DELEGATION_DEPTH, 16);
});

test('unknown error types never enter the retry allowlist', () => {
  for (const errorType of RETRYABLE_EVALUATOR_REASONS) {
    assert.equal(classifyExchangeErrorType(errorType), true, `${errorType} must be safe`);
    assert.equal(isRetryableErrorRecord(buildExchangeErrorRecord({ errorType, errorMessage: 'm' })), true);
  }
  // A bypass that reports every type retryable cannot pass the loop below.
  for (const errorType of [...TERMINAL_ERROR_TYPES, 'some_future_error', '', null, undefined, 42, {}]) {
    assert.equal(classifyExchangeErrorType(errorType), false, `${String(errorType)} must be unsafe`);
  }
  assert.equal(isRetryableErrorRecord(buildExchangeErrorRecord({
    errorType: 'replay_detected', errorMessage: 'already reserved',
  })), false);
  assert.equal(isRetryableErrorRecord(buildExchangeErrorRecord({
    errorType: 'verification_failed', errorMessage: 'threw',
  })), false);
});

test('forged records are unsafe rather than trusted', () => {
  const valid = buildExchangeErrorRecord({ errorType: 'exchange_shape_invalid', errorMessage: 'm' });
  assert.equal(isRetryableErrorRecord(valid), true);
  assert.equal(isRetryableErrorRecord({ ...valid, error_type: 'some_future_error' }), false);
  assert.equal(isRetryableErrorRecord({ ...valid, schemaVersion: 'v0' }), false);
  assert.equal(isRetryableErrorRecord({ ...valid, smuggled: true }), false);
  const { traceback_hash: dropped, ...short } = valid;
  assert.equal(isRetryableErrorRecord(short), false);
  for (const forged of [null, undefined, 'x', 42, [], {}]) {
    assert.equal(isRetryableErrorRecord(forged), false);
  }
  // Right keys and version are not enough: the values must be record-shaped.
  assert.equal(isRetryableErrorRecord({ ...valid, error_message: null }), false);
  assert.equal(isRetryableErrorRecord({ ...valid, error_message: '' }), false);
  assert.equal(isRetryableErrorRecord({ ...valid, traceback_hash: 'raw trace' }), false);
  assert.equal(isRetryableErrorRecord({ ...valid, traceback_hash: 'a'.repeat(64) }), true);
});

test('delegation depth counts the chain and names the visited agents', () => {
  const result = evaluateDelegationDepth(delegationOf(chainOf(3)));
  assert.equal(result.depth, 3);
  assert.deepEqual([...result.visitedAgentIds], ['agent-0', 'agent-1', 'agent-2']);
  assert.equal(result.withinBounds, true);
  assert.ok(Object.isFrozen(result) && Object.isFrozen(result.visitedAgentIds));
  const full = evaluateDelegationDepth(delegationOf(chainOf(16)));
  assert.equal(full.depth, 16);
  assert.equal(full.withinBounds, true);
  assert.equal(withinDelegationDepth(delegationOf(chainOf(16))), true);
});

test('over-max, repeat-visit and empty chains are out of bounds', () => {
  const over = evaluateDelegationDepth(delegationOf(chainOf(17)));
  assert.equal(over.depth, 17);
  assert.equal(over.visitedAgentIds.length, 17);
  assert.equal(over.withinBounds, false);
  assert.equal(withinDelegationDepth(delegationOf(chainOf(17))), false);
  // A bypass that drops the bound cannot pass the assertion above.
  assert.equal(withinDelegationDepth({ chain: ['a', 'b', 'a'], hops: [{}, {}] }), false);
  assert.equal(withinDelegationDepth({ chain: [], hops: [] }), false);
  assert.equal(withinDelegationDepth(null), false);
  assert.equal(withinDelegationDepth({}), false);
  assert.equal(withinDelegationDepth({ chain: 'not-an-array' }), false);
  assert.throws(() => evaluateDelegationDepth(null), /chain of bounded agent ids/);
  assert.throws(() => evaluateDelegationDepth({ chain: ['ok', 42] }), /chain of bounded agent ids/);
  // A hole is a missing agent, not a skipped one.
  // eslint-disable-next-line no-sparse-arrays
  assert.throws(() => evaluateDelegationDepth({ chain: [, 'agent-b'] }), /chain of bounded agent ids/);
  // eslint-disable-next-line no-sparse-arrays
  assert.equal(withinDelegationDepth({ chain: [, 'agent-b'] }), false);
});

test('agent ids keep the bound the validator already enforced', () => {
  const kib = 'a'.repeat(1024);
  assert.equal(withinDelegationDepth({ chain: [kib, 'agent-b'] }), true);
  assert.equal(withinDelegationDepth({ chain: [`${kib}a`, 'agent-b'] }), false);
});

test('the validator blocks an over-max chain with the stable reason', () => {
  const chain = chainOf(17);
  const request = {
    delegation: delegationOf(chain),
    participants: chain.map((agentId) => ({ agentId })),
    source: { agentId: chain[0] },
    target: { agentId: chain.at(-1) },
  };
  // Fires on the depth clause before identities or signatures are read: the
  // first checks only need shapes, and a 17-chain never gets past them.
  assert.equal(validateDelegation(request, new Map(), {}, EVALUATION_TIME), 'delegation_chain_invalid');
});

test('the valid fixture still evaluates after the validator rewiring', () => {
  const { authority, request } = buildFixture('workspace-a2a');
  const result = evaluateBoundedExchange({
    request,
    authority,
    evaluationTime: EVALUATION_TIME,
    replayReserve: () => ({ reserved: true }),
    effect: () => ({ preflight: true }),
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.reason, 'ok');
});

test('the public SDK exposes the error record and depth modules', () => {
  const index = require('../index');
  assert.equal(typeof index.buildExchangeErrorRecord, 'function');
  assert.equal(typeof index.classifyExchangeErrorType, 'function');
  assert.equal(typeof index.evaluateDelegationDepth, 'function');
  assert.equal(index.MAX_DELEGATION_DEPTH, 16);
  assert.ok(index.EXCHANGE_ERROR_TYPES.includes('replay_detected'));
});
