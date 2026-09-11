'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  EVIDENCE,
  USAGE_STATUS,
  buildUsageReport,
  evidenceFor,
  formatReport,
} = require('../scripts/capability-usage');
const { WORKFLOW_CAPABILITIES } = require('../lib/workflow-contract');

/**
 * A stand-in for the store. Real enough to answer the three questions the
 * report asks — does the table exist, how many rows match, how many approvals
 * name this tool — without needing anyone's actual memory.db.
 */
function fakeDb({ tables = {}, approvals = {} } = {}) {
  return {
    prepare(sql) {
      if (sql.includes('sqlite_master')) {
        return { get: table => (Object.hasOwn(tables, table) ? { name: table } : undefined) };
      }
      if (sql.includes('FROM tool_approvals WHERE tool = ?')) {
        return { get: (tool, legacy) => ({ c: (approvals[tool] || 0) + (approvals[legacy] || 0) }) };
      }
      const match = sql.match(/FROM (\w+) WHERE/u);
      const table = match ? match[1] : '';
      return { get: () => ({ c: tables[table] ?? 0 }) };
    },
  };
}

/**
 * A store that has the observability schema: an instrumentation stamp (or none)
 * and a gate decision count per tool name.
 */
function telemetryDb({ since = null, decisions = {} } = {}) {
  return {
    prepare(sql) {
      if (sql.includes('sqlite_master')) {
        return { get: table => (table === 'observability_events' ? { name: table } : undefined) };
      }
      if (sql.includes('capability_usage_meta')) {
        return { get: () => (since ? { value: since } : undefined) };
      }
      if (sql.includes('observability_events')) {
        return { get: (tool, legacy) => ({ c: (decisions[tool] || 0) + (decisions[legacy] || 0) }) };
      }
      return { get: () => ({ c: 0 }) };
    },
  };
}

const ALL_TABLES = {
  audit_log: 0,
  tool_approvals: 0,
  agent_runs: 0,
  candidate_claims: 0,
};

describe('capability usage evidence', () => {
  it('declares an evidence source for every capability in the contract', () => {
    const missing = WORKFLOW_CAPABILITIES
      .map(workflow => workflow.workflowId)
      .filter(id => !Object.hasOwn(EVIDENCE, id));

    assert.deepEqual(missing, [],
      'these capabilities would report UNKNOWN for no stated reason:\n  ' + missing.join('\n  '));
  });

  it('makes every "no source" entry say why, rather than leaving it blank', () => {
    for (const [id, entry] of Object.entries(EVIDENCE)) {
      if (!entry.none) continue;
      assert.equal(typeof entry.none, 'string', id);
      // "internal" or "n/a" would pass review forever without anyone rereading
      // the code, which is the failure this check exists to catch.
      assert.ok(entry.none.length > 25, `${id}: needs a reason, not a label`);
    }
  });

  // A read-only capability leaves no row of its own, which is why it reported
  // UNKNOWN. Its MCP call still passes a gate, and gate decisions are now
  // recorded against the tool name -- so the call can be counted without the
  // read writing anything about what was read.
  it('counts gate decisions for a read-only capability that has an MCP tool', () => {
    const db = telemetryDb({ since: '2026-09-11T16:58:15.761Z', decisions: { 'huqan.verify': 7 } });

    const verdict = evidenceFor({ workflowId: 'verify', mcpTool: 'huqan.verify' }, db);

    assert.equal(verdict.status, USAGE_STATUS.USED);
    assert.equal(verdict.count, 7);
    assert.match(verdict.detail, /gate decision/u);
  });

  it('names the date it started counting when a read-only capability has no decisions', () => {
    const db = telemetryDb({ since: '2026-09-11T16:58:15.761Z', decisions: {} });

    const verdict = evidenceFor({ workflowId: 'verify', mcpTool: 'huqan.verify' }, db);

    assert.equal(verdict.status, USAGE_STATUS.NEVER);
    // "never used" with no date would be a claim about all of history, which
    // this store cannot support: it started counting this morning.
    assert.match(verdict.detail, /since 2026-09-11T16:58:15\.761Z/u);
  });

  // The stamp is the whole guard. Without it an uninstrumented store would read
  // as a product nobody has ever used.
  it('stays unknown when the store was never instrumented', () => {
    const db = telemetryDb({ since: null, decisions: {} });

    const verdict = evidenceFor({ workflowId: 'verify', mcpTool: 'huqan.verify' }, db);

    assert.equal(verdict.status, USAGE_STATUS.UNKNOWN);
    assert.equal(verdict.detail, EVIDENCE.verify.none);
  });

  // compliance-audit, backup, restore and quickstart have no MCP tool, so no
  // instrumented surface reaches them. They must keep saying so.
  it('stays unknown for a capability no instrumented surface reaches', () => {
    const db = telemetryDb({ since: '2026-09-11T16:58:15.761Z', decisions: {} });

    const verdict = evidenceFor({ workflowId: 'compliance-audit' }, db);

    assert.equal(verdict.status, USAGE_STATUS.UNKNOWN);
    assert.equal(verdict.detail, EVIDENCE['compliance-audit'].none);
  });

  it('counts the pre-rename axiom.* tool name as the same capability', () => {
    const db = telemetryDb({ since: '2026-09-11T16:58:15.761Z', decisions: { 'axiom.verify': 4 } });

    const verdict = evidenceFor({ workflowId: 'verify', mcpTool: 'huqan.verify' }, db);

    assert.equal(verdict.status, USAGE_STATUS.USED);
    assert.equal(verdict.count, 4);
  });

  it('reports usage when the evidence is there', () => {
    const db = fakeDb({ tables: { ...ALL_TABLES, audit_log: 61 } });

    const verdict = evidenceFor({ workflowId: 'learn-review' }, db);

    assert.equal(verdict.status, USAGE_STATUS.USED);
    assert.equal(verdict.count, 61);
  });

  it('reports NEVER only where the evidence would have been recorded', () => {
    const db = fakeDb({ tables: ALL_TABLES });

    const verdict = evidenceFor({ workflowId: 'agent-run' }, db);

    assert.equal(verdict.status, USAGE_STATUS.NEVER);
    assert.equal(verdict.count, 0);
  });

  it('never reports NEVER for a capability that records nothing', () => {
    const db = fakeDb({ tables: ALL_TABLES });

    // This is the whole discipline of the check. A read-only capability leaves
    // no trace by design, so an empty store says nothing about it, and calling
    // that "never used" would be a confident claim with nothing behind it.
    for (const id of ['ask', 'verify', 'compliance-audit', 'deterministic-coder']) {
      assert.equal(evidenceFor({ workflowId: id }, db).status, USAGE_STATUS.UNKNOWN, id);
    }
  });

  it('counts a capability under its pre-rename tool name too', () => {
    const db = fakeDb({ tables: ALL_TABLES, approvals: { 'axiom.ingest_execute': 123 } });

    const verdict = evidenceFor({ workflowId: 'ingest-execute', mcpTool: 'huqan.ingest_execute' }, db);

    // Ignoring the legacy name would report 123 real uses as never used.
    assert.equal(verdict.status, USAGE_STATUS.USED);
    assert.equal(verdict.count, 123);
  });

  it('says unknown when the table it would read is absent', () => {
    const db = fakeDb({ tables: {} });

    const verdict = evidenceFor({ workflowId: 'agent-run' }, db);

    assert.equal(verdict.status, USAGE_STATUS.UNKNOWN);
    assert.match(verdict.detail, /not present/u);
  });

  it('does not let unknown capabilities inflate the used or never counts', () => {
    const report = buildUsageReport(fakeDb({ tables: ALL_TABLES }), WORKFLOW_CAPABILITIES);

    assert.equal(report.used.length + report.never.length + report.unknown.length, report.total);
    assert.deepEqual(report.undeclared, []);
    assert.equal(report.used.length, 0, 'an empty store cannot have anything used');
  });

  it('spells out what NEVER and UNKNOWN mean in the printed report', () => {
    const text = formatReport(buildUsageReport(fakeDb({ tables: ALL_TABLES }), WORKFLOW_CAPABILITIES), 'test.db');

    assert.match(text, /NEVER means the evidence would be recorded/u);
    assert.match(text, /silence is not evidence/u);
  });
});
