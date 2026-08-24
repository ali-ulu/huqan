'use strict';

/**
 * DELETE /api/observability/alert-rules/:id must scope itself exactly like the
 * read surfaces next to it.
 *
 * The route used to hand the raw `workspaceId` query parameter straight to
 * deleteAlertRule. A request naming no workspace was rejected with 400 on every
 * GET route, but on DELETE it was accepted and normalizeWorkspaceId resolved
 * the missing value to `default` -- deleting a rule in a workspace the caller
 * never named.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const { createObservabilityHttpRouter } = require('../lib/observability/http-router');

function makeRouter() {
  const deletes = [];
  const router = createObservabilityHttpRouter({
    getService: () => ({
      deleteAlertRule: (opts) => {
        deletes.push(opts);
        return true;
      },
    }),
    parseJsonRequest: async () => ({}),
    writeJson: (req, res, status, body) => {
      res.captured = { status, body };
    },
    denyIfUnauthorized: () => true,
    authorizeWorkspace: () => ({ allowed: true, role: 'admin' }),
  });
  return { router, deletes };
}

async function deleteRule(query) {
  const { router, deletes } = makeRouter();
  const res = {};
  const handled = await router(
    { method: 'DELETE', headers: {} },
    res,
    new URL(`http://127.0.0.1/api/observability/alert-rules/rule-1${query}`),
  );
  assert.equal(handled, true, 'the alert-rule route must handle the request');
  return { ...res.captured, deletes };
}

test('DELETE alert-rules rejects a request that names no workspace', async () => {
  const { status, body, deletes } = await deleteRule('');

  assert.equal(status, 400);
  assert.equal(body.error.code, 'MISSING_WORKSPACE_ID');
  assert.deepEqual(deletes, [], 'nothing may be deleted for an unscoped request');
});

test('DELETE alert-rules rejects an empty or repeated workspaceId', async () => {
  for (const [query, code] of [
    ['?workspaceId=', 'INVALID_WORKSPACE_ID'],
    ['?workspaceId=%20', 'INVALID_WORKSPACE_ID'],
    ['?workspaceId=a&workspaceId=b', 'INVALID_WORKSPACE_ID'],
  ]) {
    const { status, body, deletes } = await deleteRule(query);

    assert.equal(status, 400, `${query} must be rejected`);
    assert.equal(body.error.code, code);
    assert.deepEqual(deletes, []);
  }
});

test('DELETE alert-rules deletes within the validated workspace', async () => {
  const { status, body, deletes } = await deleteRule('?workspaceId=team-a');

  assert.equal(status, 200);
  assert.equal(body.ok, true);
  assert.deepEqual(deletes, [{ workspaceId: 'team-a', ruleId: 'rule-1' }]);
});

test('DELETE alert-rules applies the same workspaceId shape rules as the read surfaces', async () => {
  for (const value of ['a'.repeat(129), 'team%00a']) {
    const { status, body, deletes } = await deleteRule(`?workspaceId=${value}`);

    assert.equal(status, 400, `${value} must be rejected`);
    assert.equal(body.error.code, 'INVALID_WORKSPACE_ID');
    assert.deepEqual(deletes, []);
  }
});
