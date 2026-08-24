'use strict';

/**
 * Ingest-error state must be bounded, and the status response must stay a fixed
 * size no matter how long the process has been failing.
 *
 * company-brain and repo-memory share `kernel._companyIngestState` and both
 * carried the same unbounded push. The array grew fastest in the situation
 * nobody wants it to -- an unreachable source adds one record per attempt --
 * and the status endpoint returned all of it in one response.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  MAX_INGEST_ERRORS,
  DEFAULT_REPORTED_ERRORS,
  recordIngestError,
  summarizeIngestErrors,
} = require('../lib/bounded-ingest-errors');

function fill(count, state = { ingestErrors: [] }) {
  for (let i = 0; i < count; i += 1) {
    recordIngestError(state, 'http', `fetch failed (attempt ${i})`, `2026-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`);
  }
  return state;
}

test('the recorded array never grows past the cap', () => {
  const state = fill(MAX_INGEST_ERRORS * 10);

  assert.equal(state.ingestErrors.length, MAX_INGEST_ERRORS);
});

test('the cap drops the oldest entries, not the newest', () => {
  const state = fill(MAX_INGEST_ERRORS + 5);

  assert.match(state.ingestErrors.at(-1).message, /attempt 204\b/);
  assert.match(state.ingestErrors[0].message, /attempt 5\b/);
});

test('capping does not hide how many failures happened', () => {
  const state = fill(1000);

  assert.equal(summarizeIngestErrors(state).ingestErrorTotal, 1000);
  assert.equal(summarizeIngestErrors(state).ingestErrorsTruncated, true);
});

test('the reported view is bounded and newest first', () => {
  const state = fill(1000);

  const summary = summarizeIngestErrors(state);

  assert.equal(summary.ingestErrors.length, DEFAULT_REPORTED_ERRORS);
  assert.match(summary.ingestErrors[0].message, /attempt 999\b/, 'the most recent error comes first');
  assert.match(summary.ingestErrors.at(-1).message, /attempt 980\b/);
});

test('a short history is reported whole and not marked truncated', () => {
  const summary = summarizeIngestErrors(fill(3));

  assert.equal(summary.ingestErrors.length, 3);
  assert.equal(summary.ingestErrorTotal, 3);
  assert.equal(summary.ingestErrorsTruncated, false);
});

test('an untouched state summarizes to an empty, honest report', () => {
  const summary = summarizeIngestErrors({});

  assert.deepEqual(summary.ingestErrors, []);
  assert.equal(summary.ingestErrorTotal, 0);
  assert.equal(summary.ingestErrorsTruncated, false);
});

test('the company-brain status endpoint reports the bounded view', () => {
  const companyBrain = require('../plugins/company-brain');
  const kernel = { graph: { getStats: () => ({ nodes: 0, edges: 0 }) } };
  const state = companyBrain._test.ensureCompanyState(kernel);
  fill(1000, state);

  const status = companyBrain._test.getIngestStatus(kernel);

  assert.equal(status.ok, true);
  assert.ok(Array.isArray(status.ingestErrors), 'the field stays an array for existing callers');
  assert.equal(status.ingestErrors.length, DEFAULT_REPORTED_ERRORS);
  assert.equal(status.ingestErrorTotal, 1000);
  assert.equal(status.ingestErrorsTruncated, true);
  assert.match(status.ingestErrors[0].message, /attempt 999\b/);
});

test('the status response stays a fixed size as failures accumulate', () => {
  const small = JSON.stringify(summarizeIngestErrors(fill(50))).length;
  const large = JSON.stringify(summarizeIngestErrors(fill(200_000))).length;

  assert.ok(large < small * 2, `response grew with history: ${small} -> ${large} bytes`);
});
