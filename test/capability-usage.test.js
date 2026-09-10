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
