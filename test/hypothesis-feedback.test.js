'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const CLI = require('../cli');
const Kernel = require('../kernel');
const { isolatedKernelOptions } = require('./helpers/isolated-persistence');
const { runCliArgv } = require('../lib/cli-workflow-adapter');
const { buildHypothesisCandidate } = require('../lib/graph-hypotheses');
const { reviewHypothesisCandidate } = require('../lib/hypothesis-review');
const {
  UNKNOWN_RULE_TYPE,
  buildFeedbackStats,
  isHypothesisCandidate,
} = require('../lib/hypothesis-feedback');

function createCli(label) {
  const kernel = new Kernel(isolatedKernelOptions(label));
  const cli = new CLI({ kernelInstance: kernel });
  return { kernel, cli };
}

function closeCli({ kernel, cli }) {
  cli?.agent?.storage?.close?.();
  kernel?.graph?.close?.();
  kernel?.memory?.close?.();
}

let seq = 0;
function seedHypothesis(kernel, type, workspaceId = 'default') {
  seq += 1;
  const candidate = buildHypothesisCandidate({
    type,
    severity: 'high',
    target: `t${seq}`,
    confidence: 0.9,
    gerekce: `${type} gerekçesi ${seq}.`,
  }, workspaceId);
  kernel.addCandidateClaim(candidate, { workspaceId });
  return candidate;
}

function ruleRow(stats, ruleType) {
  return stats.rules.find(row => row.ruleType === ruleType);
}

test('rule type is parsed from the claim tag', async () => {
  const managed = createCli('feedback-parse');
  try {
    const seeded = seedHypothesis(managed.kernel, 'KRİTİK_DÜĞÜM');
    assert.equal(ruleRow(buildFeedbackStats(managed.kernel), 'KRİTİK_DÜĞÜM').total, 1);
    assert.match(seeded.claim, /^\[KRİTİK_DÜĞÜM\] /);
  } finally {
    closeCli(managed);
  }
});

test('a malformed claim is bucketed as unknown rather than dropped', async () => {
  const managed = createCli('feedback-malformed');
  try {
    const seeded = seedHypothesis(managed.kernel, 'KRİTİK_DÜĞÜM');
    managed.kernel.addCandidateClaim({ ...seeded, claim: 'etiketsiz bir iddia' }, { workspaceId: 'default' });
    const stats = buildFeedbackStats(managed.kernel);
    assert.equal(ruleRow(stats, UNKNOWN_RULE_TYPE).total, 1);
    assert.equal(stats.totals.total, 1);
  } finally {
    closeCli(managed);
  }
});

test('hypothesis-engine candidates are recognised and foreign ones are not', async () => {
  const managed = createCli('feedback-recognise');
  try {
    const seeded = seedHypothesis(managed.kernel, 'NEDENSEL_DÖNGÜ');
    assert.equal(isHypothesisCandidate(seeded), true);
    assert.equal(isHypothesisCandidate({ provenance: { sourceType: 'manual' } }), false);
    assert.equal(isHypothesisCandidate({}), false);
    assert.equal(isHypothesisCandidate(null), false);
  } finally {
    closeCli(managed);
  }
});

test('accepted / rejected / pending are counted per rule with review rates', async () => {
  const managed = createCli('feedback-counts');
  try {
    const kernel = managed.kernel;
    const a = seedHypothesis(kernel, 'KRİTİK_DÜĞÜM');
    const b = seedHypothesis(kernel, 'KRİTİK_DÜĞÜM');
    const c = seedHypothesis(kernel, 'KRİTİK_DÜĞÜM');
    seedHypothesis(kernel, 'KRİTİK_DÜĞÜM'); // stays pending
    const d = seedHypothesis(kernel, 'NEDENSEL_DÖNGÜ');

    reviewHypothesisCandidate(kernel, { candidateId: a.candidateId, decision: 'accept' });
    reviewHypothesisCandidate(kernel, { candidateId: b.candidateId, decision: 'reject' });
    reviewHypothesisCandidate(kernel, { candidateId: c.candidateId, decision: 'reject' });
    reviewHypothesisCandidate(kernel, { candidateId: d.candidateId, decision: 'accept' });

    const stats = buildFeedbackStats(kernel);
    const critical = ruleRow(stats, 'KRİTİK_DÜĞÜM');
    assert.deepEqual(
      { accepted: critical.accepted, rejected: critical.rejected, pending: critical.pending, total: critical.total },
      { accepted: 1, rejected: 2, pending: 1, total: 4 },
    );
    assert.equal(critical.reviewed, 3);
    // Rates are over reviewed candidates, not over the total: a pending
    // candidate carries no verdict and must not dilute one.
    assert.equal(critical.acceptanceRate, 1 / 3);
    assert.equal(critical.rejectionRate, 2 / 3);

    const cycle = ruleRow(stats, 'NEDENSEL_DÖNGÜ');
    assert.equal(cycle.acceptanceRate, 1);
    assert.equal(cycle.rejectionRate, 0);

    assert.deepEqual(
      { accepted: stats.totals.accepted, rejected: stats.totals.rejected, pending: stats.totals.pending, total: stats.totals.total },
      { accepted: 2, rejected: 2, pending: 1, total: 5 },
    );
  } finally {
    closeCli(managed);
  }
});

test('a rule with no verdict yet reports null rates rather than zero', async () => {
  const managed = createCli('feedback-null-rates');
  try {
    seedHypothesis(managed.kernel, 'ZAYIF_BAĞ');
    const row = ruleRow(buildFeedbackStats(managed.kernel), 'ZAYIF_BAĞ');
    assert.equal(row.reviewed, 0);
    assert.equal(row.acceptanceRate, null, 'no verdict is not the same as a 0% acceptance rate');
    assert.equal(row.rejectionRate, null);
  } finally {
    closeCli(managed);
  }
});

test('an empty candidate list produces a clean report', async () => {
  const managed = createCli('feedback-empty');
  try {
    const stats = buildFeedbackStats(managed.kernel);
    assert.deepEqual(stats.rules, []);
    assert.deepEqual(stats.totals, {
      accepted: 0, rejected: 0, pending: 0, reviewed: 0, total: 0,
      acceptanceRate: null, rejectionRate: null,
    });
    assert.equal(stats.meta.workspaceId, 'default');
  } finally {
    closeCli(managed);
  }
});

test('candidates from a foreign source are excluded from the counts', async () => {
  const managed = createCli('feedback-foreign');
  try {
    seedHypothesis(managed.kernel, 'KRİTİK_DÜĞÜM');
    managed.kernel.addCandidateClaim({
      candidateId: 'cand_foreign_1',
      claim: '[KRİTİK_DÜĞÜM] taklit bir iddia',
      workspaceId: 'default',
      status: 'rejected',
      provenance: { provenanceId: 'prov_1', sourceType: 'manual', actor: 'ali', workspaceId: 'default' },
    }, { workspaceId: 'default' });

    const stats = buildFeedbackStats(managed.kernel);
    assert.equal(stats.totals.total, 1, 'a foreign claim wearing a rule tag is still foreign');
    assert.equal(stats.totals.rejected, 0);
  } finally {
    closeCli(managed);
  }
});

test('output is deterministic across repeated calls and sorted by rule type', async () => {
  const managed = createCli('feedback-deterministic');
  try {
    for (const type of ['ZAYIF_BAĞ', 'KRİTİK_DÜĞÜM', 'NEDENSEL_DÖNGÜ', 'KRİTİK_DÜĞÜM']) {
      seedHypothesis(managed.kernel, type);
    }
    const first = buildFeedbackStats(managed.kernel);
    const second = buildFeedbackStats(managed.kernel);
    assert.deepEqual(first, second);
    assert.deepEqual(
      first.rules.map(row => row.ruleType),
      [...first.rules.map(row => row.ruleType)].sort((l, r) => l.localeCompare(r)),
    );
  } finally {
    closeCli(managed);
  }
});

test('workspace isolation holds', async () => {
  const managed = createCli('feedback-workspace');
  try {
    seedHypothesis(managed.kernel, 'KRİTİK_DÜĞÜM', 'alpha');
    seedHypothesis(managed.kernel, 'ZAYIF_BAĞ', 'beta');
    const alpha = buildFeedbackStats(managed.kernel, { workspaceId: 'alpha' });
    assert.equal(alpha.totals.total, 1);
    assert.equal(alpha.rules[0].ruleType, 'KRİTİK_DÜĞÜM');
    assert.equal(buildFeedbackStats(managed.kernel, { workspaceId: 'beta' }).rules[0].ruleType, 'ZAYIF_BAĞ');
  } finally {
    closeCli(managed);
  }
});

test('the report writes nothing: no node, edge, candidate or audit event', async () => {
  const managed = createCli('feedback-read-only');
  try {
    const kernel = managed.kernel;
    const seeded = seedHypothesis(kernel, 'KRİTİK_DÜĞÜM');
    reviewHypothesisCandidate(kernel, { candidateId: seeded.candidateId, decision: 'accept' });

    const before = {
      nodes: kernel.graph.getNodes('default').length,
      edges: kernel.graph.getAllEdges('default').length,
      candidates: JSON.stringify(kernel.getCandidateClaims({ workspaceId: 'default' })),
      audit: kernel.graph.getAuditEvents({ workspaceId: 'default' }).length,
    };
    const calls = [];
    for (const method of ['addNode', 'addEdge', 'addCandidateClaim', 'appendAuditEvent']) {
      const original = kernel.graph[method].bind(kernel.graph);
      kernel.graph[method] = (...args) => { calls.push(method); return original(...args); };
    }

    buildFeedbackStats(kernel);

    assert.deepEqual(calls, []);
    assert.deepEqual({
      nodes: kernel.graph.getNodes('default').length,
      edges: kernel.graph.getAllEdges('default').length,
      candidates: JSON.stringify(kernel.getCandidateClaims({ workspaceId: 'default' })),
      audit: kernel.graph.getAuditEvents({ workspaceId: 'default' }).length,
    }, before);
  } finally {
    closeCli(managed);
  }
});

test('hypotheses feedback is reachable from the CLI and emits a JSON workflow envelope', async () => {
  const managed = createCli('feedback-cli');
  try {
    const seeded = seedHypothesis(managed.kernel, 'KRİTİK_DÜĞÜM');
    reviewHypothesisCandidate(managed.kernel, { candidateId: seeded.candidateId, decision: 'reject' });
    const stdout = [];
    const result = await runCliArgv(['hypotheses', 'feedback', '--json'], {
      cli: managed.cli,
      stdout: value => stdout.push(value),
    });
    const envelope = JSON.parse(stdout[0]);
    assert.equal(result.exitCode, 0);
    assert.equal(envelope.workflowId, 'hypotheses');
    assert.equal(envelope.status, 'completed');
    const row = envelope.data.feedback.rules.find(item => item.ruleType === 'KRİTİK_DÜĞÜM');
    assert.equal(row.rejected, 1);
    assert.equal(row.rejectionRate, 1);
  } finally {
    closeCli(managed);
  }
});

test('hypotheses feedback records no CLI mutation audit entry', async () => {
  const managed = createCli('feedback-cli-readonly');
  try {
    seedHypothesis(managed.kernel, 'KRİTİK_DÜĞÜM');
    const before = managed.kernel.graph.getAuditEvents({ workspaceId: 'default' }).length;
    await runCliArgv(['hypotheses', 'feedback', '--json'], { cli: managed.cli, stdout: () => {} });
    assert.equal(managed.kernel.graph.getAuditEvents({ workspaceId: 'default' }).length, before);
  } finally {
    closeCli(managed);
  }
});
