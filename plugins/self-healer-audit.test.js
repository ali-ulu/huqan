const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const selfHealerAudit = require('./self-healer-audit');
const { ensureAuditState, unclassifiedModuleFinding, runReachabilityAudit } = selfHealerAudit._test;

function fakeKernel() {
  return {};
}

test('self-healer-audit: unclassifiedModuleFinding produces a schema-valid finding', () => {
  const { validateFinding, normalizeFinding } = require('../lib/self-healer/finding-schema');
  const raw = unclassifiedModuleFinding('lib/some-orphan.js', 'default');
  const normalized = normalizeFinding(raw, { workspaceId: 'default' });
  const validation = validateFinding(normalized);
  assert.equal(validation.ok, true, `expected a valid finding, got errors: ${JSON.stringify(validation.errors)}`);
  assert.equal(normalized.kind, 'release_hygiene');
  assert.deepEqual(normalized.affectedFiles, ['lib/some-orphan.js']);
});

test('self-healer-audit: runReachabilityAudit against a fixture repo with one orphan module produces one proposal', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-selfheal-'));
  try {
    fs.writeFileSync(path.join(dir, 'cli.js'), "require('./used');\n");
    fs.writeFileSync(path.join(dir, 'used.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(dir, 'orphan.js'), 'module.exports = {};\n');

    const kernel = fakeKernel();
    const result = runReachabilityAudit(kernel, { root: dir, workspaceId: 'default' });

    assert.equal(result.ok, true);
    assert.equal(result.unacknowledgedCount, 1);
    assert.equal(result.findingCount, 1);
    assert.equal(result.applied, false);
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].applied, false);
    assert.ok(result.proposals[0].receiptSummary);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('self-healer-audit: a fixture repo with no orphans produces zero findings and zero proposals', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-selfheal-clean-'));
  try {
    fs.writeFileSync(path.join(dir, 'cli.js'), "require('./used');\n");
    fs.writeFileSync(path.join(dir, 'used.js'), 'module.exports = {};\n');

    const kernel = fakeKernel();
    const result = runReachabilityAudit(kernel, { root: dir, workspaceId: 'default' });
    assert.equal(result.unacknowledgedCount, 0);
    assert.equal(result.proposals.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('self-healer-audit: never applies anything, regardless of finding count', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-selfheal-noapply-'));
  try {
    fs.writeFileSync(path.join(dir, 'cli.js'), 'module.exports = {};\n');
    for (let i = 0; i < 5; i += 1) {
      fs.writeFileSync(path.join(dir, `orphan${i}.js`), 'module.exports = {};\n');
    }
    const kernel = fakeKernel();
    const result = runReachabilityAudit(kernel, { root: dir, workspaceId: 'default' });
    assert.equal(result.applied, false);
    for (const proposal of result.proposals) {
      assert.equal(proposal.applied, false);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('self-healer-audit: AB10 budget accumulates across calls and eventually blocks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-selfheal-budget-'));
  try {
    fs.writeFileSync(path.join(dir, 'cli.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(dir, 'orphan.js'), 'module.exports = {};\n');

    const kernel = fakeKernel();
    const opts = { root: dir, workspaceId: 'default', maxIterationsPerWindow: 2 };
    const first = runReachabilityAudit(kernel, opts);
    const second = runReachabilityAudit(kernel, opts);
    const third = runReachabilityAudit(kernel, opts);

    assert.equal(first.blockedByBudget, false);
    assert.equal(second.blockedByBudget, false);
    assert.equal(third.blockedByBudget, true, 'the budget should eventually block repeated scans');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('self-healer-audit: run() scan action end to end', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-selfheal-run-'));
  try {
    fs.writeFileSync(path.join(dir, 'cli.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(dir, 'orphan.js'), 'module.exports = {};\n');
    const kernel = fakeKernel();
    const result = selfHealerAudit.run(kernel, { action: 'scan', root: dir });
    assert.equal(result.ok, true);
    assert.equal(result.unacknowledgedCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('self-healer-audit: simulate routes a Dream candidate through approval and receipt without apply', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-selfheal-sim-'));
  try {
    fs.writeFileSync(path.join(dir, 'entry.js'), "module.exports = require('./middle');\n");
    fs.writeFileSync(path.join(dir, 'middle.js'), "module.exports = require('./leaf');\n");
    fs.writeFileSync(path.join(dir, 'leaf.js'), 'module.exports = 1;\n');
    const result = await selfHealerAudit.run(fakeKernel(), {
      action: 'simulate',
      root: dir,
      targetPath: 'entry.js',
      workspaceId: 'default',
    });
    assert.equal(result.ok, true);
    assert.equal(result.applied, false);
    assert.equal(result.findingCount, 1);
    assert.equal(result.proposals.length, 1);
    assert.equal(result.proposals[0].decision, 'require_review');
    assert.equal(result.proposals[0].requiresApproval, true);
    assert.ok(result.proposals[0].approvalRequest);
    assert.ok(result.proposals[0].receiptSummary);
    assert.equal(result.simulation.candidate.patchIncluded, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('self-healer-audit: run() rejects an unsupported action', () => {
  const kernel = fakeKernel();
  const result = selfHealerAudit.run(kernel, { action: 'nonsense' });
  assert.equal(result.ok, false);
});

test('self-healer-audit: the real repo root does not throw and produces a well-formed result', () => {
  const kernel = fakeKernel();
  const result = selfHealerAudit.run(kernel, { action: 'scan' });
  assert.equal(result.ok, true);
  assert.equal(typeof result.unacknowledgedCount, 'number');
  assert.equal(result.applied, false);
});
