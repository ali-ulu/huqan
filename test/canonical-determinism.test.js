const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-canonical-determinism-'));

test.after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeKernel(name) {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    loadPlugins: false,
    memoryPath: path.join(tempDir, `${name}.json`),
  });
  kernel._autoMaintain = () => {};
  kernel.maintenanceEvery = Number.MAX_SAFE_INTEGER;
  kernel._learnCount = 0;
  return kernel;
}

function hashJson(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function normalizeEdge(edge) {
  return {
    from: edge.from,
    to: edge.to,
    relation: edge.relation,
    confidence: edge.confidence ?? null,
    weight: edge.weight ?? null,
    workspaceId: edge.workspaceId ?? null,
    evidence: Array.isArray(edge.evidence) ? [...edge.evidence].sort() : [],
  };
}

function normalizeSignal(signal) {
  return {
    rule: signal.rule || '',
    kind: signal.kind || '',
    severity: signal.severity ?? null,
    confidence: signal.confidence ?? null,
    flags: Array.isArray(signal.flags) ? [...signal.flags].sort() : [],
    detail: signal.detail || '',
    evidence: Array.isArray(signal.evidence)
      ? signal.evidence
          .map((item) => ({
            role: item.role || '',
            text: item.text || '',
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : [],
    meta: signal.meta
      ? Object.keys(signal.meta)
          .sort()
          .reduce((acc, key) => {
            acc[key] = signal.meta[key];
            return acc;
          }, {})
      : {},
  };
}

function normalizeReasoningStep(step) {
  return {
    type: step.type || '',
    subclaimId: step.subclaimId || '',
    claim: step.claim || '',
    status: step.status || '',
    confidence: step.confidence ?? null,
    rule: step.rule || '',
    reasons: Array.isArray(step.reasons) ? [...step.reasons].sort() : [],
    warnings: Array.isArray(step.warnings) ? [...step.warnings].sort() : [],
    downgradeReasons: Array.isArray(step.downgradeReasons) ? [...step.downgradeReasons].sort() : [],
    evidence: Array.isArray(step.evidence)
      ? step.evidence
          .map((item) => ({
            kind: item.kind || '',
            text: item.text || '',
            confidence: item.confidence ?? null,
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : [],
    rejectedEvidence: Array.isArray(step.rejectedEvidence)
      ? step.rejectedEvidence
          .map((item) => ({
            kind: item.kind || '',
            text: item.text || '',
            confidence: item.confidence ?? null,
          }))
          .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : [],
  };
}

function normalizeVerifyResult(raw, kernel, subject) {
  const semanticTrust = raw.meta?.semanticTrust || {};
  const reasoningTrace = raw.meta?.reasoningTrace || {};
  const receipt = raw.meta?.trustReceiptPreview || {};
  const edges = kernel.graph.getEdges(subject, 'default').map(normalizeEdge);
  edges.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  return {
    verdict: {
      status: raw.data?.status || '',
      confidence: raw.data?.confidence ?? null,
    },
    semanticTrust: {
      status: semanticTrust.status || '',
      classification: semanticTrust.classification || '',
      supportScore: semanticTrust.supportScore ?? null,
      contradictionScore: semanticTrust.contradictionScore ?? null,
      riskScore: semanticTrust.riskScore ?? null,
      matchType: semanticTrust.matchType || '',
      warnings: Array.isArray(semanticTrust.warnings) ? [...semanticTrust.warnings].sort() : [],
      riskFlags: Array.isArray(semanticTrust.risk?.flags) ? [...semanticTrust.risk.flags].sort() : [],
      thresholds: semanticTrust.thresholds || {},
      signals: Array.isArray(semanticTrust.signals)
        ? semanticTrust.signals.map(normalizeSignal).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
        : [],
    },
    reasoningTrace: {
      status: reasoningTrace.status || '',
      confidence: reasoningTrace.confidence ?? null,
      mode: reasoningTrace.mode || '',
      summary: reasoningTrace.summary || {},
      trustReceiptPreview: {
        finalStatus: reasoningTrace.trustReceiptPreview?.finalStatus || '',
        confidence: reasoningTrace.trustReceiptPreview?.confidence ?? null,
        subclaimCount: reasoningTrace.trustReceiptPreview?.subclaimCount ?? null,
        contradictionCount: reasoningTrace.trustReceiptPreview?.contradictionCount ?? null,
        evidenceCount: reasoningTrace.trustReceiptPreview?.evidenceCount ?? null,
        canonical: reasoningTrace.trustReceiptPreview?.canonical ?? null,
        semanticFlags: Array.isArray(reasoningTrace.trustReceiptPreview?.semanticFlags)
          ? [...reasoningTrace.trustReceiptPreview.semanticFlags].sort()
          : [],
        downgradeReasons: Array.isArray(reasoningTrace.trustReceiptPreview?.downgradeReasons)
          ? [...reasoningTrace.trustReceiptPreview.downgradeReasons].sort()
          : [],
      },
      steps: Array.isArray(reasoningTrace.steps)
        ? reasoningTrace.steps.map(normalizeReasoningStep)
        : [],
    },
    receipt: {
      finalStatus: receipt.finalStatus || '',
      confidence: receipt.confidence ?? null,
      subclaimCount: receipt.subclaimCount ?? null,
      contradictionCount: receipt.contradictionCount ?? null,
      evidenceCount: receipt.evidenceCount ?? null,
      canonical: receipt.canonical ?? null,
      semanticFlags: Array.isArray(receipt.semanticFlags) ? [...receipt.semanticFlags].sort() : [],
      downgradeReasons: Array.isArray(receipt.downgradeReasons) ? [...receipt.downgradeReasons].sort() : [],
    },
    graph: {
      subject,
      edges,
    },
  };
}

function runScenario(iteration) {
  const kernel = makeKernel(`scenario-${iteration}`);
  const learnRaw = kernel.learn('Asilama hastaligi onler', { workspaceId: 'default' });
  const verifyRaw = kernel.verify('Asilama hastaliga neden olur', { workspaceId: 'default' });

  return {
    learnRaw,
    verifyRaw,
    canonical: normalizeVerifyResult(verifyRaw, kernel, 'asilama'),
  };
}

test('canonical verdict hash stays stable across fresh kernels even when raw payload differs', () => {
  const runs = [runScenario(1), runScenario(2), runScenario(3)];
  const rawHashes = runs.map((run) => hashJson({
    learnRaw: run.learnRaw,
    verifyRaw: run.verifyRaw,
  }));
  const canonicalHashes = runs.map((run) => hashJson(run.canonical));

  assert.notStrictEqual(new Set(rawHashes).size, 1, 'full raw payload should differ because volatile metadata is present');
  assert.strictEqual(new Set(canonicalHashes).size, 1, 'canonical payload hash should be stable across repeated fresh kernels');

  for (const run of runs) {
    assert.strictEqual(run.canonical.verdict.status, 'celiski');
    assert.strictEqual(run.canonical.verdict.confidence, 0.95);
    assert.deepStrictEqual(run.canonical.semanticTrust.warnings, [
      'CAUSE_PREVENT_OPPOSITION',
      'SEMANTIC_OPPOSITION',
    ]);
    assert.deepStrictEqual(run.canonical.receipt.semanticFlags, [
      'CAUSE_PREVENT_OPPOSITION',
      'CONTRADICTION_SUBCLAIM',
      'SEMANTIC_OPPOSITION',
    ]);
    assert.deepStrictEqual(run.canonical.graph.edges, [
      {
        from: 'asilama',
        to: 'hastalik',
        relation: 'PREVENTS',
        confidence: 0.5,
        weight: 0.5,
        workspaceId: 'default',
        evidence: ['Asilama hastaligi onler'],
      },
    ]);
  }
});
