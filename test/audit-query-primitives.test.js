const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  AUDIT_FILTER_COLUMNS,
  AUDIT_QUERY_DEFAULT_LIMIT,
  AUDIT_QUERY_MAX_LIMIT,
  buildAuditFilter,
  clampAuditLimit,
  compareEvents,
  decodeAuditCursor,
  encodeAuditCursor,
  queryAuditEvents,
} = require('../lib/audit-query');

/**
 * Characterisation of the pure query primitives (#2270): limit clamping,
 * cursor encode/decode, filter construction, event comparison and the
 * row -> event mapping.
 *
 * Everything here is driven through the public facade on purpose. The test has
 * to describe the same behaviour before and after the primitives move into
 * their own module, so an assertion that could only be written against the new
 * module would make it a rewrite witness rather than a behaviour lock.
 *
 * The row -> event mapping is reached through queryAuditEvents() with a stub
 * context, because rowToEvent() is not part of the public surface and the
 * mapping is only observable as the shape of the returned page.
 */

const b64url = (value) => Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');

/** A context whose reader-side collaborators are stubs, so no SQLite is involved. */
function stubCtx(rows, { events = [] } = {}) {
  return {
    db: { prepare: () => ({ all: () => rows }) },
    stmts: {
      countAuditEvents: { get: () => ({ total: rows.length }) },
      allAuditEvents: { all: () => [] },
    },
    events,
    statementCache: new Map(),
  };
}

/** The page for one synthetic table row, which is the only way the mapping is visible. */
function rowToEvents(row) {
  return queryAuditEvents(stubCtx([row]), { limit: 10 }).items;
}

describe('audit-query pure primitives (#2270)', () => {
  it('clampAuditLimit falls back when the value names no positive page', () => {
    for (const value of [undefined, null, '', 'abc', NaN, Infinity, -Infinity, 0, -5, -0.5, false]) {
      assert.strictEqual(clampAuditLimit(value), AUDIT_QUERY_DEFAULT_LIMIT, `value: ${String(value)}`);
    }
    assert.strictEqual(AUDIT_QUERY_DEFAULT_LIMIT, 100);
  });

  it('clampAuditLimit floors, lower-bounds and caps the page size', () => {
    assert.strictEqual(clampAuditLimit(0.5), 1, 'a positive fraction floors to 0 and is lifted to 1');
    assert.strictEqual(clampAuditLimit(1), 1);
    assert.strictEqual(clampAuditLimit('25'), 25);
    assert.strictEqual(clampAuditLimit(true), 1, 'Number(true) is 1');
    assert.strictEqual(clampAuditLimit(499.9), 499);
    assert.strictEqual(clampAuditLimit(AUDIT_QUERY_MAX_LIMIT), AUDIT_QUERY_MAX_LIMIT);
    assert.strictEqual(clampAuditLimit(AUDIT_QUERY_MAX_LIMIT + 1), AUDIT_QUERY_MAX_LIMIT);
    assert.strictEqual(clampAuditLimit(10_000), AUDIT_QUERY_MAX_LIMIT);
    assert.strictEqual(AUDIT_QUERY_MAX_LIMIT, 500);
  });

  it('clampAuditLimit returns a caller-supplied fallback unclamped', () => {
    assert.strictEqual(clampAuditLimit(0, 42), 42);
    assert.strictEqual(clampAuditLimit('abc', 7), 7);
    assert.strictEqual(clampAuditLimit(undefined, 5000), 5000, 'the fallback is not run through the ceiling');
    assert.strictEqual(clampAuditLimit(9, 42), 9, 'a servable value wins over the fallback');
  });

  it('AUDIT_FILTER_COLUMNS is the frozen ordered key -> column map', () => {
    assert.ok(Object.isFrozen(AUDIT_FILTER_COLUMNS));
    assert.deepStrictEqual(AUDIT_FILTER_COLUMNS, [
      ['auditId', 'audit_id'],
      ['eventType', 'event_type'],
      ['targetType', 'target_type'],
      ['targetId', 'target_id'],
      ['actor', 'actor'],
      ['provenanceId', 'provenance_id'],
      ['trustPolicyVersion', 'trust_policy_version'],
      ['sourceRef', 'source_ref'],
    ]);
    assert.ok(
      !AUDIT_FILTER_COLUMNS.some(([key]) => key === 'workspaceId'),
      'workspaceId is not a plain equality and must not appear here',
    );
  });

  it('buildAuditFilter builds one equality clause per filter column', () => {
    for (const [key, column] of AUDIT_FILTER_COLUMNS) {
      assert.deepStrictEqual(
        buildAuditFilter({ [key]: 'v' }),
        { clauses: [`${column} = ?`], params: ['v'], impossible: false },
        `filter: ${key}`,
      );
    }
  });

  it('buildAuditFilter keeps column order and appends the workspace clause last', () => {
    assert.deepStrictEqual(
      buildAuditFilter({ sourceRef: 'r', targetId: 't', actor: 'a', workspaceId: 'ws' }),
      {
        clauses: ['target_id = ?', 'actor = ?', 'source_ref = ?', 'COALESCE(workspace_id, ?) = ?'],
        params: ['t', 'a', 'r', 'default', 'ws'],
        impossible: false,
      },
    );
    assert.deepStrictEqual(buildAuditFilter({ auditId: 7 }), {
      clauses: ['audit_id = ?'],
      params: ['7'],
      impossible: false,
    }, 'a non-string filter value is stringified');
  });

  it('buildAuditFilter skips absent and falsy filter values', () => {
    const empty = { clauses: [], params: [], impossible: false };
    assert.deepStrictEqual(buildAuditFilter(), empty);
    assert.deepStrictEqual(buildAuditFilter(null), empty, 'an explicit null filters is empty, not an error');
    assert.deepStrictEqual(buildAuditFilter('auditId'), empty, 'a non-object filters value yields nothing');
    assert.deepStrictEqual(buildAuditFilter({ auditId: '' }), empty);
    assert.deepStrictEqual(buildAuditFilter({ eventType: 0 }), empty);
    assert.deepStrictEqual(buildAuditFilter({ targetId: null }), empty);
    assert.deepStrictEqual(buildAuditFilter({ actor: false }), empty);
  });

  it('buildAuditFilter marks a blank workspace filter impossible', () => {
    assert.deepStrictEqual(buildAuditFilter({ workspaceId: '' }), {
      clauses: [], params: [], impossible: true,
    });
    assert.deepStrictEqual(buildAuditFilter({ workspaceId: '   ' }), {
      clauses: [], params: [], impossible: true,
    });
    assert.deepStrictEqual(buildAuditFilter({ targetId: 't', workspaceId: '' }), {
      clauses: ['target_id = ?'], params: ['t'], impossible: true,
    }, 'the clauses already built survive the impossible verdict');
  });

  it('buildAuditFilter treats a null workspace filter as every workspace', () => {
    assert.deepStrictEqual(buildAuditFilter({ workspaceId: null }), {
      clauses: [], params: [], impossible: false,
    });
    assert.deepStrictEqual(buildAuditFilter({ workspaceId: undefined }), {
      clauses: [], params: [], impossible: false,
    });
    assert.deepStrictEqual(buildAuditFilter({ workspaceId: 0 }), {
      clauses: ['COALESCE(workspace_id, ?) = ?'], params: ['default', '0'], impossible: false,
    });
  });

  it('cursor encode/decode round-trips the sort key', () => {
    const event = { timestamp: '2026-01-01T00:00:00.000Z', targetId: 'node-1', auditId: 'a1' };
    const cursor = encodeAuditCursor(event);
    assert.strictEqual(cursor, b64url(['2026-01-01T00:00:00.000Z', 'node-1', 'a1']));
    assert.deepStrictEqual(decodeAuditCursor(cursor), ['2026-01-01T00:00:00.000Z', 'node-1', 'a1']);
  });

  it('cursor encode fills the sort key from a partial event', () => {
    assert.strictEqual(encodeAuditCursor({}), b64url(['', '', '']));
    assert.strictEqual(
      encodeAuditCursor({ auditId: 'only' }),
      b64url(['', '', 'only']),
      'timestamp and targetId are absent, not undefined',
    );
    assert.strictEqual(encodeAuditCursor({ targetId: 0 }), b64url(['', '', '']), '0 is falsy in the sort key');
  });

  it('encodeAuditCursor returns null for a missing event', () => {
    for (const value of [null, undefined, 0, '', false]) {
      assert.strictEqual(encodeAuditCursor(value), null, `value: ${String(value)}`);
    }
  });

  it('decodeAuditCursor refuses a malformed or foreign cursor', () => {
    for (const cursor of [
      null,
      undefined,
      42,
      '',
      'not-a-real-cursor!!',
      b64url({ timestamp: 'x' }),
      b64url([]),
      b64url(['a', 'b']),
      b64url(['a', 'b', 'c', 'd']),
      b64url(null),
      Buffer.from('{not json', 'utf8').toString('base64url'),
    ]) {
      assert.strictEqual(decodeAuditCursor(cursor), null, `cursor: ${String(cursor)}`);
    }
  });

  it('decodeAuditCursor stringifies each cursor part', () => {
    assert.deepStrictEqual(decodeAuditCursor(b64url(['1', null, 3])), ['1', '', '3']);
    assert.deepStrictEqual(decodeAuditCursor(b64url([0, false, 'ok'])), ['0', 'false', 'ok']);
  });

  it('compareEvents orders by timestamp, then targetId, then auditId', () => {
    const earlier = { timestamp: '2026-01-01T00:00:00.000Z', targetId: 'node-1', auditId: 'a1' };
    const later = { timestamp: '2026-01-02T00:00:00.000Z', targetId: 'node-1', auditId: 'a1' };
    const otherTarget = { timestamp: '2026-01-01T00:00:00.000Z', targetId: 'node-2', auditId: 'a1' };
    const sameTargetEarlierId = { timestamp: '2026-01-01T00:00:00.000Z', targetId: 'node-1', auditId: 'a0' };

    assert.ok(compareEvents(earlier, later) < 0);
    assert.ok(compareEvents(later, earlier) > 0);
    assert.ok(compareEvents(earlier, otherTarget) < 0);
    assert.ok(compareEvents(earlier, sameTargetEarlierId) > 0, 'auditId is the tie-break, ascending');

    const sorted = [later, otherTarget, sameTargetEarlierId, earlier].sort((a, b) => compareEvents(a, b));
    assert.deepStrictEqual(sorted.map((event) => [event.timestamp, event.targetId, event.auditId]), [
      ['2026-01-01T00:00:00.000Z', 'node-1', 'a0'],
      ['2026-01-01T00:00:00.000Z', 'node-1', 'a1'],
      ['2026-01-01T00:00:00.000Z', 'node-2', 'a1'],
      ['2026-01-02T00:00:00.000Z', 'node-1', 'a1'],
    ]);
  });

  it('compareEvents ties on all three keys and only reverses for desc', () => {
    const left = { timestamp: 't', targetId: 'x', auditId: '1' };
    const right = { timestamp: 't', targetId: 'x', auditId: '2' };
    const same = { timestamp: 't', targetId: 'x', auditId: '1' };

    assert.strictEqual(compareEvents(left, same), 0);
    assert.strictEqual(compareEvents(left, same, 'desc'), 0, 'an exact tie has no direction');
    assert.ok(compareEvents(left, right) < 0);
    assert.ok(compareEvents(left, right, 'desc') > 0);
    assert.ok(compareEvents(right, left, 'desc') < 0);
    assert.ok(compareEvents(left, right, 'DESC') < 0, 'only the exact string desc reverses');
  });

  it('compareEvents reads a missing event as an empty sort key', () => {
    const blank = { timestamp: '', targetId: '', auditId: '' };
    assert.strictEqual(compareEvents(null, blank), 0);
    assert.ok(compareEvents(null, { auditId: 'a' }) < 0);
  });

  it('the page reader maps a table row into a normalised audit event', () => {
    const items = rowToEvents({
      audit_id: 'a1',
      event_type: 'memory.write',
      target_type: 'node',
      target_id: 'node-1',
      workspace_id: 'ws-1',
      actor: 'reviewer',
      timestamp: '2026-01-01T00:00:00.000Z',
      source_ref: 'src-1',
      provenance_id: 'prov-1',
      trust_policy_version: 'tpv-1',
      details: '{"reason":"ok"}',
    });

    assert.deepStrictEqual(items, [{
      auditId: 'a1',
      eventType: 'memory.write',
      targetType: 'node',
      targetId: 'node-1',
      workspaceId: 'ws-1',
      actor: 'reviewer',
      timestamp: '2026-01-01T00:00:00.000Z',
      sourceRef: 'src-1',
      provenanceId: 'prov-1',
      trustPolicyVersion: 'tpv-1',
      details: { reason: 'ok' },
    }]);
  });

  it('the page reader defaults the nullable row columns', () => {
    const items = rowToEvents({
      audit_id: 'a2',
      event_type: 'memory.write',
      target_type: null,
      target_id: null,
      workspace_id: null,
      actor: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      source_ref: null,
      provenance_id: null,
      trust_policy_version: null,
      details: null,
    });

    assert.deepStrictEqual(items, [{
      auditId: 'a2',
      eventType: 'memory.write',
      targetType: '',
      targetId: '',
      workspaceId: 'default',
      actor: 'system',
      timestamp: '2026-01-01T00:00:00.000Z',
      sourceRef: '',
      provenanceId: '',
      trustPolicyVersion: '',
      details: {},
    }]);
  });

  it('the page reader treats an empty-string workspace or actor as absent', () => {
    const [item] = rowToEvents({
      audit_id: 'a3',
      event_type: 'memory.write',
      workspace_id: '',
      actor: '',
      timestamp: '2026-01-01T00:00:00.000Z',
      details: '{}',
    });

    assert.strictEqual(item.workspaceId, 'default');
    assert.strictEqual(item.actor, 'system');
  });

  it('the page reader keeps the row order it was handed', () => {
    const stroke = (id) => ({
      audit_id: id,
      event_type: 'memory.write',
      timestamp: `2026-01-0${id.slice(1)}T00:00:00.000Z`,
      details: '{}',
    });
    const page = queryAuditEvents(stubCtx([stroke('a1'), stroke('a2'), stroke('a3')]), { limit: 10 });
    assert.deepStrictEqual(page.items.map((event) => event.auditId), ['a1', 'a2', 'a3']);
    assert.strictEqual(page.hasMore, false);
    assert.strictEqual(page.nextCursor, null);
  });

  it('the page reader refuses a row whose details are not JSON', () => {
    assert.throws(() => rowToEvents({
      audit_id: 'a4',
      event_type: 'memory.write',
      timestamp: '2026-01-01T00:00:00.000Z',
      details: 'not json',
    }), SyntaxError);
  });
});
