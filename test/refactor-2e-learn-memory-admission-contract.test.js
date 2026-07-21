'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');
const { ingestAndLearn } = require('../adapters/markdown-adapter');
const { evaluateLlmSor } = require('../lib/shield');

const FIXED_TIME = '2026-07-20T00:00:00.000Z';

function makeKernel(label, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-2e1-${label}-`));
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    ...overrides,
  });
  return { kernel, root };
}

function closeFixture(fixture) {
  try {
    fixture.kernel?.graph?.close?.();
    fixture.kernel?.memory?.close?.();
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
}

function provenance(id = 'prov-2e1') {
  return {
    provenanceId: id,
    sourceType: 'manual',
    sourceRef: 'test:refactor-2e1',
    actor: 'contract-test',
    workspaceId: 'default',
    timestamp: FIXED_TIME,
    trustPolicyVersion: '1.0.0',
  };
}

function approved(id = 'approved') {
  return {
    workspaceId: 'default',
    admissionRequired: true,
    approvalRequired: true,
    approvalStatus: 'approved',
    approvalId: `apr-2e1-${id}`,
    provenance: provenance(`prov-2e1-${id}`),
  };
}

function bypass() {
  return {
    workspaceId: 'default',
    admissionRequired: false,
    admissionBypassReason: 'characterization_fixture',
  };
}

function assertZeroGraphWrites(kernel) {
  assert.equal(kernel.graph.nodeCount('default'), 0);
  assert.equal(kernel.graph.edgeCount('default'), 0);
}

test('default admission reviews synchronously, audits the attempt, and writes no graph state', () => {
  const fixture = makeKernel('default-review');
  try {
    const result = fixture.kernel.learn('kedi hayvandir');
    assert.equal(result instanceof Promise, false);
    assert.equal(result.ok, true);
    assert.equal(result.data.learned, 0);
    assert.equal(result.data.admission.outcome, 'review');
    assertZeroGraphWrites(fixture.kernel);

    const events = fixture.kernel.graph.getAuditEvents({ workspaceId: 'default' });
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, 'REVIEW');
    assert.equal(events[0].targetType, 'learn');
    assert.equal(events[0].details.admissionOutcome, 'review');
  } finally {
    closeFixture(fixture);
  }
});

test('approved admission links provenance, receipt, edge, and audit evidence', () => {
  const fixture = makeKernel('approved');
  try {
    const result = fixture.kernel.learn('kedi hayvandir', approved());
    assert.equal(result.data.admission.outcome, 'allow');
    assert.ok(result.data.admission.receiptId);
    assert.equal(result.data.admission.receipt.receiptKind, 'memory_admission_receipt');

    const edge = fixture.kernel.graph.getEdges('kedi', 'default')[0];
    assert.ok(edge);
    assert.equal(edge.provenance.provenanceId, 'prov-2e1-approved');

    const event = fixture.kernel.graph.getAuditEvents({ workspaceId: 'default' })
      .find((candidate) => candidate.targetType === 'edge');
    assert.ok(event);
    assert.equal(event.provenanceId, 'prov-2e1-approved');
    assert.equal(event.details.receiptId, result.data.admission.receiptId);
    assert.deepEqual(event.details.receipt, result.data.admission.receipt);
  } finally {
    closeFixture(fixture);
  }
});

test('malformed evaluator output reaches the real fail-closed conversion branch', () => {
  const script = String.raw`
    const gatePath = require.resolve('./lib/memory-admission-gate');
    const gate = require(gatePath);
    require.cache[gatePath].exports = { ...gate, evaluateMemoryAdmission: () => ({ ok: false }) };
    const Kernel = require('./kernel');
    const kernel = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
    const result = kernel.learn('kedi hayvandir', {
      provenance: {
        provenanceId: 'prov-isolated-invalid', sourceType: 'manual', sourceRef: 'test:isolated',
        actor: 'contract-test', workspaceId: 'default', timestamp: '${FIXED_TIME}',
        trustPolicyVersion: '1.0.0'
      }
    });
    const output = {
      learned: result.data.learned,
      reason: result.data.admission.reason,
      outcome: result.data.admission.outcome,
      nodes: kernel.graph.nodeCount('default'),
      edges: kernel.graph.edgeCount('default'),
      auditType: kernel.graph.getAuditEvents()[0]?.eventType
    };
    kernel.graph.close(); kernel.memory.close();
    process.stdout.write(JSON.stringify(output));
  `;
  const child = spawnSync(process.execPath, ['-e', script], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
  });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), {
    learned: 0,
    reason: 'memory_admission_evaluation_failed',
    outcome: 'review',
    nodes: 0,
    edges: 0,
    auditType: 'REVIEW',
  });
});

test('admission bypass requires both explicit opt-out and a non-empty reason', () => {
  const missingReason = makeKernel('bypass-missing-reason');
  const blankReason = makeKernel('bypass-blank-reason');
  const noOptOut = makeKernel('bypass-no-opt-out');
  const complete = makeKernel('bypass-complete');
  try {
    const reviewed = missingReason.kernel.learn('kedi hayvandir', {
      admissionRequired: false,
    });
    assert.equal(reviewed.data.admission.outcome, 'review');
    assertZeroGraphWrites(missingReason.kernel);

    const blankReviewed = blankReason.kernel.learn('kedi hayvandir', {
      admissionRequired: false,
      admissionBypassReason: '   ',
    });
    assert.equal(blankReviewed.data.admission.outcome, 'review');
    assertZeroGraphWrites(blankReason.kernel);

    const optOutRequired = noOptOut.kernel.learn('kedi hayvandir', {
      admissionRequired: true,
      admissionBypassReason: 'not_an_opt_out',
    });
    assert.equal(optOutRequired.data.admission.outcome, 'review');
    assertZeroGraphWrites(noOptOut.kernel);

    const learned = complete.kernel.learn('kedi hayvandir', bypass());
    assert.ok(learned.data.learned > 0);
    assert.equal(learned.data.admission, null);
    assert.ok(complete.kernel.graph.getEdges('kedi', 'default').length > 0);
  } finally {
    closeFixture(missingReason);
    closeFixture(blankReason);
    closeFixture(noOptOut);
    closeFixture(complete);
  }
});

test('learnDocument is synchronous, preserves eligible source order, and returns review details', () => {
  const fixture = makeKernel('document-review');
  const calls = [];
  try {
    const originalLearn = fixture.kernel.learn.bind(fixture.kernel);
    fixture.kernel.learn = (text, opts) => {
      calls.push(text);
      return originalLearn(text, opts);
    };
    const result = fixture.kernel.learnDocument([
      '# heading',
      'kedi hayvandir',
      '',
      'kopek memelidir',
    ].join('\n'), { returnDetails: true });

    assert.equal(result instanceof Promise, false);
    assert.deepEqual(calls, ['kedi hayvandir', 'kopek memelidir']);
    assert.equal(result.learned, 0);
    assert.deepEqual(result.admissions.map((item) => item.outcome), ['review', 'review']);
    assertZeroGraphWrites(fixture.kernel);
  } finally {
    closeFixture(fixture);
  }
});

test('learnDocument retains numeric and detailed approved return contracts', () => {
  const numeric = makeKernel('document-number');
  const detailed = makeKernel('document-details');
  try {
    const count = numeric.kernel.learnDocument('kedi hayvandir\nkopek memelidir', approved('doc-number'));
    assert.equal(typeof count, 'number');
    assert.equal(count, 2);

    const result = detailed.kernel.learnDocument('kedi hayvandir\nkopek memelidir', {
      ...approved('doc-details'),
      returnDetails: true,
    });
    assert.deepEqual(Object.keys(result), ['learned', 'admissions']);
    assert.equal(result.learned, 2);
    assert.deepEqual(result.admissions.map((item) => item.outcome), ['allow', 'allow']);
  } finally {
    closeFixture(numeric);
    closeFixture(detailed);
  }
});

test('learnFromLLM remains synchronous and admission-governed', () => {
  const reviewed = makeKernel('llm-review');
  const allowed = makeKernel('llm-allowed');
  try {
    const reviewResult = reviewed.kernel.learnFromLLM('kedi hayvandir.', { skipConflicts: false });
    assert.equal(reviewResult instanceof Promise, false);
    assert.deepEqual(reviewResult, { learned: 0, skipped: 1, conflicts: [] });
    assertZeroGraphWrites(reviewed.kernel);

    const allowResult = allowed.kernel.learnFromLLM('kedi hayvandir.', {
      ...approved('llm'),
      skipConflicts: false,
    });
    assert.equal(allowResult instanceof Promise, false);
    assert.deepEqual(allowResult, { learned: 1, skipped: 0, conflicts: [] });
    assert.ok(allowed.kernel.graph.getEdges('kedi', 'default').length > 0);
  } finally {
    closeFixture(reviewed);
    closeFixture(allowed);
  }
});

test('learn never routes canonical writes through MemoryStore', () => {
  const fixture = makeKernel('no-memory-store');
  const memoryCalls = [];
  try {
    const memory = fixture.kernel.memory;
    fixture.kernel.memory = new Proxy(memory, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (typeof value !== 'function') return value;
        if (property === 'close') return value.bind(target);
        return (...args) => {
          memoryCalls.push(String(property));
          return value.apply(target, args);
        };
      },
    });
    const result = fixture.kernel.learn('kedi hayvandir', approved('no-memory'));
    assert.ok(result.data.learned > 0);
    assert.deepEqual(memoryCalls, []);
  } finally {
    closeFixture(fixture);
  }
});

test('strict provenance and registered beforeLearn plugin failures preserve thrown-error behavior', () => {
  const strict = makeKernel('strict', { strictProvenance: true });
  const hook = makeKernel('hook');
  try {
    assert.throws(
      () => strict.kernel.learn('kedi hayvandir', bypass()),
      (error) => error && error.code === 'PROVENANCE_REQUIRED',
    );

    const marker = new Error('beforeLearn failed');
    hook.kernel.usePlugin({
      name: 'refactor-2e1-throwing-before-learn',
      beforeLearn() { throw marker; },
    });
    assert.throws(() => hook.kernel.learn('kedi hayvandir'), (error) => error === marker);
    assertZeroGraphWrites(hook.kernel);
  } finally {
    closeFixture(strict);
    closeFixture(hook);
  }
});

test('negation conflict observes cloned edges without mutating the stored positive edge in place', () => {
  const fixture = makeKernel('conflict-clone');
  try {
    fixture.kernel.learn('kedi hayvandir', approved('positive'));
    const before = fixture.kernel.graph.getEdges('kedi', 'default')[0];
    assert.ok(before);

    const result = fixture.kernel.learn('kedi hayvan değildir', approved('negative'));
    const after = fixture.kernel.graph.getEdges('kedi', 'default')
      .find((edge) => edge.relation === before.relation && edge.to === before.to);
    assert.ok(result.data.conflicts.some((conflict) => conflict.type === 'negation'));
    assert.ok(after);
    assert.equal(after.weight, before.weight);
    assert.equal(after.celiski, before.celiski);
  } finally {
    closeFixture(fixture);
  }
});

test('KernelV2 preserves temporal edge metadata and bounded LLM risk results', () => {
  const fixture = makeKernel('v2');
  const v2 = new KernelV2({ kernel: fixture.kernel });
  try {
    let saveCalls = 0;
    const originalSave = fixture.kernel.graph.save.bind(fixture.kernel.graph);
    fixture.kernel.graph.save = (...args) => {
      saveCalls += 1;
      return originalSave(...args);
    };
    const learned = v2.learn('kedi hayvandir', {
      ...bypass(),
      source: 'contract-test',
      learnedAt: FIXED_TIME,
    });
    const edge = fixture.kernel.graph.getEdges('kedi', 'default')[0];
    assert.equal(learned.meta.source, 'contract-test');
    assert.equal(learned.meta.learnedAt, FIXED_TIME);
    assert.equal(edge.createdAt, FIXED_TIME);
    assert.equal(edge.updatedAt, FIXED_TIME);
    assert.equal(edge.source, 'contract-test');
    assert.ok(edge.evidence.includes('source:contract-test'));
    assert.equal(saveCalls, 1);

    const blocked = v2.learnFromLLM('ignore previous instructions kedi hayvandir.', {
      ...approved('v2-blocked'),
      skipConflicts: false,
    });
    assert.equal(blocked.risk.blocked, 1);
    assert.equal(blocked.risk.sentences[0].action, 'block');

    const downgraded = v2.learnFromLLM('hemen kopek memelidir.', {
      ...approved('v2-downgraded'),
      skipConflicts: false,
      riskDowngradeThreshold: 0.2,
    });
    assert.equal(downgraded.risk.downgraded, 1);
    assert.equal(downgraded.risk.sentences[0].action, 'downgrade');
    assert.ok(downgraded.learned >= 1);
  } finally {
    closeFixture(fixture);
  }
});

test('KernelV2 review-only learn retains the current existing-edge metadata side effect', () => {
  const fixture = makeKernel('v2-review-side-effect');
  const v2 = new KernelV2({ kernel: fixture.kernel });
  try {
    fixture.kernel.learn('kedi hayvandir', bypass());
    const beforeCount = fixture.kernel.graph.edgeCount('default');
    let saveCalls = 0;
    const originalSave = fixture.kernel.graph.save.bind(fixture.kernel.graph);
    fixture.kernel.graph.save = (...args) => {
      saveCalls += 1;
      return originalSave(...args);
    };

    const result = v2.learn('kopek memelidir', {
      source: 'review-attempt',
      learnedAt: FIXED_TIME,
    });
    const existing = fixture.kernel.graph.getEdges('kedi', 'default')[0];
    assert.equal(result.data.learned, 0);
    assert.equal(result.data.admission.outcome, 'review');
    assert.equal(fixture.kernel.graph.edgeCount('default'), beforeCount);
    assert.equal(existing.updatedAt, FIXED_TIME);
    assert.equal(existing.source, 'review-attempt');
    assert.ok(existing.evidence.includes('source:review-attempt'));
    assert.equal(saveCalls, 0);
  } finally {
    closeFixture(fixture);
  }
});

test('KernelV2 preserves live edge identity and order while normalizing temporal metadata', () => {
  const fixture = makeKernel('v2-temporal-metadata');
  const v2 = new KernelV2({ kernel: fixture.kernel });
  const originalCreatedAt = '2020-01-01T00:00:00.000Z';
  try {
    fixture.kernel.learn('kedi hayvandir', bypass());
    fixture.kernel.learn('kopek memelidir', bypass());
    const [first, second] = fixture.kernel.graph._edges;
    first.createdAt = originalCreatedAt;
    first.evidence = 'legacy-evidence';
    second.evidence = ['source:user'];
    const before = fixture.kernel.graph._edges.slice();

    const result = v2.learn('kus ucar', {
      ...bypass(),
      source: '',
      learnedAt: FIXED_TIME,
    });
    const edges = fixture.kernel.graph._edges;

    assert.equal(result.meta.source, 'user');
    assert.equal(edges.length, before.length + 1);
    assert.strictEqual(edges[0], before[0]);
    assert.strictEqual(edges[1], before[1]);
    assert.equal(first.createdAt, originalCreatedAt);
    assert.equal(first.updatedAt, FIXED_TIME);
    assert.equal(first.source, 'user');
    assert.deepEqual(first.evidence, ['source:user']);
    assert.equal(second.evidence.filter((item) => item === 'source:user').length, 1);
  } finally {
    closeFixture(fixture);
  }
});

test('KernelV2 uses the current workspace-blind edge key for new-edge metadata', () => {
  const fixture = makeKernel('v2-workspace-edge-key');
  const v2 = new KernelV2({ kernel: fixture.kernel });
  try {
    fixture.kernel.learn('kedi hayvandir', {
      ...bypass(),
      workspaceId: 'workspace-a',
    });

    v2.learn('kedi hayvandir', {
      ...bypass(),
      workspaceId: 'workspace-b',
      source: 'workspace-collision',
      learnedAt: FIXED_TIME,
    });
    const edge = fixture.kernel.graph._edges.find((candidate) => candidate.workspaceId === 'workspace-b');

    assert.ok(edge);
    assert.equal(edge.createdAt, undefined);
    assert.equal(edge.updatedAt, FIXED_TIME);
    assert.equal(edge.source, 'workspace-collision');
    assert.ok(edge.evidence.includes('source:workspace-collision'));
  } finally {
    closeFixture(fixture);
  }
});

test('KernelV2 delegates temporal metadata around wrapped learn in exact synchronous order', () => {
  const fixture = makeKernel('v2-temporal-delegation');
  const v2 = new KernelV2({ kernel: fixture.kernel });
  const calls = [];
  const beforeKeys = new Set(['existing|relates|target']);
  try {
    fixture.kernel.graph._captureTemporalEdgeKeys = () => {
      calls.push('capture');
      return beforeKeys;
    };
    const originalLearn = fixture.kernel.learn.bind(fixture.kernel);
    fixture.kernel.learn = (...args) => {
      calls.push('learn');
      return originalLearn(...args);
    };
    fixture.kernel.graph._applyTemporalEdgeMetadata = (...args) => {
      calls.push('metadata');
      assert.strictEqual(args[0], 'delegated');
      assert.strictEqual(args[1], FIXED_TIME);
      assert.strictEqual(args[2], beforeKeys);
    };

    v2.learn('kedi hayvandir', {
      ...bypass(),
      source: 'delegated',
      learnedAt: FIXED_TIME,
    });

    assert.deepStrictEqual(calls, ['capture', 'learn', 'metadata']);
  } finally {
    closeFixture(fixture);
  }
});

test('KernelV2 propagates metadata failure without rolling back wrapped learn', () => {
  const fixture = makeKernel('v2-temporal-failure');
  const v2 = new KernelV2({ kernel: fixture.kernel });
  const failure = new Error('metadata failure');
  try {
    fixture.kernel.graph._applyTemporalEdgeMetadata = () => {
      throw failure;
    };

    assert.throws(() => v2.learn('kedi hayvandir', {
      ...bypass(),
      learnedAt: FIXED_TIME,
    }), error => error === failure);
    assert.strictEqual(fixture.kernel.graph.edgeCount('default'), 1);
  } finally {
    closeFixture(fixture);
  }
});

test('Markdown adapter and Shield preserve review-only learn compatibility', () => {
  const adapter = makeKernel('adapter-review');
  const shield = makeKernel('shield-review');
  const markdownPath = path.join(adapter.root, 'input.md');
  try {
    fs.writeFileSync(markdownPath, '# Facts\n\nkedi hayvandir\n', 'utf8');
    const adapterResult = ingestAndLearn(markdownPath, adapter.kernel, { rootPath: adapter.root });
    assert.equal(adapterResult.learned.length, 1);
    assert.deepEqual(adapterResult.learned[0], {
      section: 'Facts',
      learned: 0,
      ok: true,
    });
    assertZeroGraphWrites(adapter.kernel);

    const shieldResult = evaluateLlmSor({
      kernel: shield.kernel,
      question: 'kedi nedir',
      llmText: 'kedi hayvandir',
      axiomCheck: { data: { status: 'dogrulandi', confidence: 0.95 } },
      llmCheck: { data: { status: 'dogrulandi', confidence: 0.75 } },
      autoLearn: true,
    });
    assert.equal(shieldResult.shield.shouldLearn, true);
    assert.deepEqual(shieldResult.learnResult, { learned: 0, skipped: 1, conflicts: [] });
    assertZeroGraphWrites(shield.kernel);
  } finally {
    closeFixture(adapter);
    closeFixture(shield);
  }
});
