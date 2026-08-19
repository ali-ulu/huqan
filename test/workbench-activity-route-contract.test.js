'use strict';

const assert = require('node:assert');
const test = require('node:test');
const { describe } = test;
const {
  projectActivityEvent,
  queryAgentActivity,
} = require('../lib/workbench/activity-read');
const {
  createWorkbenchReadHttpRouter,
} = require('../lib/workbench/workbench-read-http-router');

function sampleEvent() {
  return {
    auditId: 'audit-1',
    eventType: 'UPDATE',
    targetType: 'memory',
    targetId: 'memory-1',
    workspaceId: 'workspace-a',
    actor: 'agent-1',
    timestamp: '2026-08-19T09:00:00.000Z',
    sourceRef: 'issue-328',
    provenanceId: 'prov-1',
    trustPolicyVersion: 'v5',
    details: {
      action: 'patchMetadata',
      toolName: 'memory.patchMetadata',
      traceId: 'trace-1',
      secret: 'must-not-leak',
      receipt: {
        receiptId: 'rcpt-1',
        decision: 'allow',
        reason: 'policy_passed',
        action: 'patchMetadata',
        createdAt: '2026-08-19T09:00:00.000Z',
        metadata: {
          action: 'patchMetadata',
          tool: 'memory.patchMetadata',
          agentId: 'agent-1',
          traceId: 'trace-1',
          private: 'must-not-leak',
        },
        privateField: 'must-not-leak',
      },
    },
  };
}

test('activity projection exposes action and receipt summary without raw audit details', () => {
  const projected = projectActivityEvent(sampleEvent());

  assert.deepStrictEqual(projected.receipt, {
    receiptId: 'rcpt-1',
    decision: 'allow',
    reason: 'policy_passed',
    action: 'patchMetadata',
    tool: 'memory.patchMetadata',
    agentId: 'agent-1',
    traceId: 'trace-1',
    createdAt: '2026-08-19T09:00:00.000Z',
  });
  assert.strictEqual(projected.action, 'patchMetadata');
  assert.strictEqual(projected.tool, 'memory.patchMetadata');
  assert.strictEqual(projected.traceId, 'trace-1');
  assert.ok(!JSON.stringify(projected).includes('must-not-leak'));
  assert.ok(!Object.prototype.hasOwnProperty.call(projected, 'details'));
});

test('activity query is bounded, workspace-scoped and preserves keyset metadata', () => {
  const calls = [];
  const source = {
    queryAuditEvents(options) {
      calls.push(options);
      return {
        items: [sampleEvent()],
        hasMore: true,
        nextCursor: 'next-cursor',
        limit: 2,
      };
    },
  };

  const result = queryAgentActivity(source, {
    workspaceId: 'workspace-a',
    actor: 'agent-1',
    eventType: 'UPDATE',
    limit: '2',
    order: 'asc',
    cursor: 'cursor-1',
  });

  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.hasMore, true);
  assert.strictEqual(result.nextCursor, 'next-cursor');
  assert.strictEqual(result.items.length, 1);
  assert.strictEqual(calls.length, 1);
  assert.deepStrictEqual(calls[0], {
    filters: { workspaceId: 'workspace-a', eventType: 'UPDATE', actor: 'agent-1' },
    limit: 2,
    cursor: 'cursor-1',
    order: 'asc',
  });
});

test('activity query fails closed when the bounded source is unavailable', () => {
  const result = queryAgentActivity({});
  assert.deepStrictEqual(result, {
    ok: false,
    status: 'unavailable',
    error: { code: 'ACTIVITY_SOURCE_UNAVAILABLE' },
  });
});

describe('Workbench activity HTTP route', () => {
  function captureRoute({ pathname = '/api/workbench/activity', method = 'GET', search = '?workspaceId=workspace-a', authorized = true, graph } = {}) {
    const captured = [];
    const router = createWorkbenchReadHttpRouter({
      writeJson: (req, res, statusCode, body, headers) => captured.push({ statusCode, body, headers }),
      writeApiError: () => {},
      denyIfUnauthorized: () => {
        if (!authorized) {
          captured.push({ statusCode: 401, body: { ok: false }, headers: {} });
          return false;
        }
        return true;
      },
      readTrustFilters: () => ({}),
      readReceiptById: () => ({ ok: false, status: 'not_found' }),
    });
    router({ method }, {}, new URL(`http://localhost${pathname}${search}`), graph || {
      queryAuditEvents: () => ({ items: [], hasMore: false, nextCursor: null, limit: 100 }),
    });
    return captured;
  }

  test('returns a bounded activity page with no-store headers', () => {
    const captured = captureRoute({
      search: '?workspaceId=workspace-a&eventType=UPDATE&actor=agent-1&limit=2&order=desc',
      graph: {
        queryAuditEvents: (options) => {
          assert.deepStrictEqual(options.filters, {
            workspaceId: 'workspace-a',
            eventType: 'UPDATE',
            actor: 'agent-1',
          });
          return { items: [sampleEvent()], hasMore: false, nextCursor: null, limit: 2 };
        },
      },
    });

    assert.strictEqual(captured.length, 1);
    assert.strictEqual(captured[0].statusCode, 200);
    assert.strictEqual(captured[0].body.ok, true);
    assert.strictEqual(captured[0].body.items[0].receipt.receiptId, 'rcpt-1');
    assert.strictEqual(captured[0].headers['Cache-Control'], 'no-store');
    assert.strictEqual(captured[0].headers['X-Content-Type-Options'], 'nosniff');
  });

  test('requires exactly one workspace and never reaches the source for invalid scope', () => {
    let queried = false;
    const graph = { queryAuditEvents: () => { queried = true; return {}; } };
    for (const search of ['', '?workspaceId=', '?workspaceId=a&workspaceId=b']) {
      const captured = captureRoute({ search, graph });
      assert.strictEqual(captured[0].statusCode, 400);
      assert.strictEqual(queried, false);
    }
  });

  test('rejects mutation methods, malformed limits and malformed order', () => {
    for (const input of [
      { method: 'POST', search: '?workspaceId=workspace-a' },
      { search: '?workspaceId=workspace-a&limit=0' },
      { search: '?workspaceId=workspace-a&limit=2.5' },
      { search: '?workspaceId=workspace-a&order=sideways' },
    ]) {
      const captured = captureRoute(input);
      assert.strictEqual(captured[0].statusCode, input.method === 'POST' ? 405 : 400);
    }
  });

  test('keeps unauthorized callers outside the activity source', () => {
    let queried = false;
    const captured = captureRoute({
      authorized: false,
      graph: { queryAuditEvents: () => { queried = true; return {}; } },
    });
    assert.strictEqual(captured[0].statusCode, 401);
    assert.strictEqual(queried, false);
  });
});
