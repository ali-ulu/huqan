'use strict';

/**
 * GET /api/v2/pr-guardian/reviews must read the approval store once.
 *
 * The route previously called service().list(limit) twice in the same response
 * literal: once for the rows, once for their count. That doubled the most
 * expensive part of the request and let the count describe a different snapshot
 * than the rows it counted.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createPrGuardianRoutes } = require('../lib/http/pr-guardian-routes');

const OPERATOR_TOKEN = 'operator-secret';
const REVIEWS_URL = 'http://127.0.0.1/api/v2/pr-guardian/reviews';

function makeStore(rowsPerCall) {
  const calls = [];
  let call = 0;
  return {
    calls,
    saveToolApprovalIfAbsent: () => ({}),
    listUnresolvedToolApprovals: (limit) => {
      calls.push(limit);
      const rows = rowsPerCall[Math.min(call, rowsPerCall.length - 1)];
      call += 1;
      return rows;
    },
  };
}

function approvalRow(id) {
  return {
    id,
    tool: 'github.pr.guardian',
    status: 'pending',
    workspaceId: 'github:acme/app',
    args: { repo: 'acme/app', number: 1 },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

async function getReviews(store, { search = '' } = {}) {
  const captured = {};
  const routes = createPrGuardianRoutes({
    operatorToken: OPERATOR_TOKEN,
    webhookSecret: 'webhook-secret',
    getApprovalStore: () => store,
    parseJsonRequest: async () => ({}),
    writeJson: (req, res, status, payload) => {
      captured.status = status;
      captured.payload = payload;
    },
  });

  const req = { method: 'GET', headers: { 'x-huqan-operator-token': OPERATOR_TOKEN } };
  const reqUrl = new URL(REVIEWS_URL + search);
  const handled = await routes.route(req, {}, reqUrl);

  assert.equal(handled, true, 'the reviews route must handle the request');
  return captured;
}

test('GET /reviews lists the approval store exactly once', async () => {
  const store = makeStore([[approvalRow('a'), approvalRow('b')]]);

  const { status, payload } = await getReviews(store);

  assert.equal(status, 200);
  assert.equal(store.calls.length, 1, 'the store must be listed once, not once per response field');
  assert.equal(payload.data.reviews.length, 2);
});

test('GET /reviews reports returned and limit from the same read', async () => {
  // A second, differing read would previously have produced the count: if the
  // response still agreed with its own rows here, that could only come from a
  // single snapshot.
  const store = makeStore([[approvalRow('a'), approvalRow('b')], [approvalRow('a')]]);

  const { payload } = await getReviews(store, { search: '?limit=7' });

  assert.equal(payload.data.returned, payload.data.reviews.length);
  assert.equal(payload.data.returned, 2);
  assert.equal(payload.data.limit, 7, 'the applied limit is reported so a full page is recognizable');
  assert.equal(store.calls[0], 7);
});

test('GET /reviews no longer reports a limit-capped count as a total', async () => {
  const store = makeStore([[approvalRow('a')]]);

  const { payload } = await getReviews(store);

  assert.equal('total' in payload.data, false, 'a value capped by limit must not be named total');
  assert.equal(payload.data.limit, 50, 'the default limit is reported');
});
