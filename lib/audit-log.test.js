const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Graph = require('../graph');
const {
  AUDIT_EVENTS,
  appendAuditEvent,
  buildAuditEvent,
  getAuditEvents,
} = require('./audit-log');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-audit-'));

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeProvenance() {
  return {
    provenanceId: 'prov-001',
    sourceRef: 'docs/claim.md#1',
    sourceTitle: 'Claim',
    sourceType: 'github',
    sourceSubType: 'release_tag',
    actor: 'builder',
    timestamp: '2026-06-02T00:00:00Z',
    confidence: 0.88,
    workspaceId: 'workspace-a',
    trustPolicyVersion: '0.8.0',
  };
}

describe('Audit Log', () => {
  it('buildAuditEvent fills required fields and copies provenance metadata', () => {
    const provenance = makeProvenance();
    const event = buildAuditEvent({
      eventType: AUDIT_EVENTS.LEARN,
      targetType: 'edge',
      targetId: 'kedi|tür|hayvan',
      details: { ok: true, fn: () => {}, count: 1n },
    }, { provenance });

    assert.ok(event.auditId);
    assert.strictEqual(event.eventType, AUDIT_EVENTS.LEARN);
    assert.strictEqual(event.workspaceId, 'workspace-a');
    assert.strictEqual(event.actor, 'builder');
    assert.strictEqual(event.sourceRef, provenance.sourceRef);
    assert.strictEqual(event.provenanceId, provenance.provenanceId);
    assert.strictEqual(event.trustPolicyVersion, provenance.trustPolicyVersion);
    assert.deepStrictEqual(event.details.ok, true);
    assert.ok(typeof event.timestamp === 'string' && event.timestamp.length > 0);
    assert.doesNotThrow(() => JSON.stringify(event.details));
  });

  it('appendAuditEvent appends to an in-memory array', () => {
    const events = [];
    const event = appendAuditEvent(events, {
      eventType: AUDIT_EVENTS.QUERY,
      targetType: 'graph',
      targetId: 'stats',
      details: { query: 'stats' },
    });

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].auditId, event.auditId);
    assert.strictEqual(events[0].eventType, AUDIT_EVENTS.QUERY);
  });

  it('getAuditEvents filters by eventType', () => {
    const events = [
      buildAuditEvent({ eventType: AUDIT_EVENTS.LEARN, targetType: 'edge', targetId: 'a' }),
      buildAuditEvent({ eventType: AUDIT_EVENTS.REJECT, targetType: 'learn', targetId: 'b' }),
      buildAuditEvent({ eventType: AUDIT_EVENTS.LEARN, targetType: 'edge', targetId: 'c' }),
    ];

    const filtered = getAuditEvents(events, { eventType: AUDIT_EVENTS.LEARN });
    assert.strictEqual(filtered.length, 2);
    assert.ok(filtered.every((event) => event.eventType === AUDIT_EVENTS.LEARN));
  });

  it('filters by workspaceId and preserves default workspace for legacy events', () => {
    const events = [
      buildAuditEvent({ eventType: AUDIT_EVENTS.LEARN, targetType: 'edge', targetId: 'a', workspaceId: 'workspace-a' }),
      buildAuditEvent({ eventType: AUDIT_EVENTS.LEARN, targetType: 'edge', targetId: 'b' }),
    ];

    const scoped = getAuditEvents(events, { workspaceId: 'workspace-a' });
    const defaultScoped = getAuditEvents(events, {});

    assert.strictEqual(scoped.length, 1);
    assert.strictEqual(scoped[0].workspaceId, 'workspace-a');
    assert.strictEqual(defaultScoped.length, 1);
    assert.strictEqual(defaultScoped[0].workspaceId, 'default');
  });

  it('persists audit_log in SQLite and enforces append-only triggers', (t) => {
    const graph = new Graph({
      memoryPath: path.join(tempDir, 'audit.json'),
      useSQLite: true,
    });

    if (graph.getStats().backend !== 'sqlite') {
      graph.close();
      return t.skip('better-sqlite3 is unavailable');
    }

    t.after(() => graph.close());

    const provenance = makeProvenance();
    const event = graph.appendAuditEvent({
      eventType: AUDIT_EVENTS.LEARN,
      targetType: 'edge',
      targetId: 'kedi|tür|hayvan',
      details: { hello: 'world' },
    }, { provenance });

    graph.save();
    const events = graph.getAuditEvents({ eventType: AUDIT_EVENTS.LEARN, workspaceId: provenance.workspaceId });
    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].provenanceId, provenance.provenanceId);

    assert.throws(() => {
      graph._db.prepare('UPDATE audit_log SET actor = ? WHERE audit_id = ?').run('changed', event.auditId);
    }, /append-only/i);

    assert.throws(() => {
      graph._db.prepare('DELETE FROM audit_log WHERE audit_id = ?').run(event.auditId);
    }, /append-only/i);

    const reopened = new Graph({
      memoryPath: path.join(tempDir, 'audit.json'),
      useSQLite: true,
    });
    if (reopened.getStats().backend === 'sqlite') {
      t.after(() => reopened.close());
      reopened.load();
      const loaded = reopened.getAuditEvents({ eventType: AUDIT_EVENTS.LEARN, workspaceId: provenance.workspaceId });
      assert.strictEqual(loaded.length, 1);
      assert.strictEqual(loaded[0].provenanceId, provenance.provenanceId);
      assert.strictEqual(loaded[0].trustPolicyVersion, '0.8.0');
    } else {
      reopened.close();
    }
  });
});
