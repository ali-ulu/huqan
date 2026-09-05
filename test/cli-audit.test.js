'use strict';

/**
 * `audit` CLI command — EU AI Act compliance report (#1909).
 *
 * Locks in: flag parsing, read-only behavior (no graph/store/filesystem
 * mutation), JSON + text shapes, degradation when the approval store is
 * unavailable, and end-to-end dispatch through parse + execute.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  parseAuditArgs,
  buildAuditReport,
  runCliAudit,
} = require('../lib/cli-audit');
const { parseCommand } = require('../lib/command-parser');
const CLI = require('../cli');
const Kernel = require('../kernel');

function stubKernel() {
  return {
    contractVersion: 'test-contract',
    graph: {
      getStats: () => ({ nodes: 3, edges: 2 }),
      countAuditEvents: () => 7,
    },
  };
}

test('audit args default to eu-ai-act and the default workspace', () => {
  assert.deepEqual(parseAuditArgs(''), { framework: 'eu-ai-act', workspaceId: 'default' });
  assert.deepEqual(parseAuditArgs('--eu-ai-act --workspace tenant-a'), { framework: 'eu-ai-act', workspaceId: 'tenant-a' });
  assert.deepEqual(parseAuditArgs('--framework eu-ai-act -w tenant-b'), { framework: 'eu-ai-act', workspaceId: 'tenant-b' });
});

test('audit args reject unknown frameworks, workspaces and flags', () => {
  for (const raw of ['--framework sox', '--workspace "../evil"', '--workspace ""', '--explode']) {
    assert.throws(() => parseAuditArgs(raw), /Usage|Unsupported|Invalid/, raw);
  }
});

test('audit report carries all three articles with bounded evidence', () => {
  const report = buildAuditReport({ kernel: stubKernel(), workspaceId: 'default', versions: { huqanVersion: '0.0.0-test' } });
  assert.equal(report.schemaVersion, 'huqan-audit-report-v1');
  assert.equal(report.framework, 'eu-ai-act');
  assert.ok(report.generatedAt);
  assert.deepEqual(Object.keys(report.articles), ['art12_record_keeping', 'art13_transparency', 'art14_human_oversight', 'trust_score']);
  assert.equal(report.articles.art12_record_keeping.evidence.auditEventsTotal, 7);
  assert.equal(report.articles.art12_record_keeping.evidence.graphNodes, 3);
  assert.ok(Array.isArray(report.limitations) && report.limitations.length > 0);
  // No approval store is passed: art14 degrades to info, it never throws
  // and never invents counts.
  assert.equal(report.articles.art14_human_oversight.status, 'info');
  assert.equal(report.articles.art14_human_oversight.evidence.pendingApprovals, null);
});

test('audit reports live approval counts when a store is provided', () => {
  const store = { countPendingToolApprovals: () => 2, countUnresolvedToolApprovals: () => 5 };
  const report = buildAuditReport({ kernel: stubKernel(), workspaceId: 'default', versions: {}, getApprovalStore: () => store });
  assert.equal(report.articles.art14_human_oversight.status, 'pass');
  assert.equal(report.articles.art14_human_oversight.evidence.pendingApprovals, 2);
  assert.equal(report.articles.art14_human_oversight.evidence.unresolvedApprovals, 5);
});

test('audit output honors json and text shapes', () => {
  const kernel = stubKernel();
  const json = runCliAudit(kernel, '', { json: true });
  assert.equal(json.status, 'completed');
  assert.equal(json.data.framework, 'eu-ai-act');
  const text = runCliAudit(kernel, '--workspace default', {});
  assert.ok(typeof text === 'string' && text.includes('Art 14') && text.includes('limitations:'));
});

test('audit is reachable through parse and CLI dispatch', () => {
  const parsed = parseCommand('audit --eu-ai-act --workspace default');
  assert.equal(parsed.command, 'audit');
  const cli = new CLI({ kernelInstance: new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false }) });
  const out = cli.execute('audit', '--workspace default', {});
  assert.ok(typeof out === 'string' && out.includes('Art 12'));
});
