'use strict';

// #3496 (R41): derivation-trace recording cost + idempotent-dedup measurement.
//
// Issue #3496 asks for the cost of recording a verifiable derivation trace and
// for a decision on whether recording should be default-on. This bench supplies
// the cost half; docs/derivation-trace-default-decision.md supplies the scope
// decision it feeds.
//
// It measures the inference runtime's existing record surface -- it does not
// add a new one:
//
//   - derivation cost: evaluateSemiNaive over a bounded fixture (transitive
//     edge chain + type inheritance), which is the work already done whether or
//     not a trace is kept;
//   - record cost: buildRecords over those candidates, giving buildMs, bytes
//     per run and bytes per record -- the marginal cost of keeping the trace;
//   - idempotent dedup: within one run the semi-naive engine suppresses a fact
//     derivable by two rules (duplicateSuppressed), and across reruns the
//     derivationId is a deterministic hash, so a re-derived record collides
//     with the stored one instead of duplicating it.
//
// Output is measurements, not a gate. The only failure is a fixture that stops
// deriving anything, which would make every number meaningless.

const {
  variable,
  constant,
  atom,
  createRule,
} = require('../lib/inference-rule-ir');
const { evaluateSemiNaive } = require('../lib/inference-semi-naive');
const { buildRecords, reconcile } = require('../lib/inference-runtime-records');
const { factKey } = require('../lib/inference-semi-naive-values');

const VERSION = '1.0.0';
const DEFAULT_SIZES = [100, 400, 1000];
const WORKSPACE = 'derivation-trace';

function fact(predicate, ...values) {
  return atom(predicate, values.map(constant));
}

function parseSizes() {
  const hit = process.argv.find((arg) => arg.startsWith('--sizes='));
  if (!hit) return DEFAULT_SIZES;
  return hit.slice('--sizes='.length).split(',')
    .map((s) => Math.max(1, Number(s) || 1));
}

// Two rules that each fire exactly once per dataset index. Both join their
// subject fact against a single shared `is_a(hub, disease)` fact, so the join is
// linear in n rather than the O(n^2) a transitive edge-chain rule would cost.
// That keeps the record surface -- not evaluation -- the thing being measured.
function buildRules() {
  return [
    createRule({
      id: 'rule:reachable',
      head: atom('reachable', [variable('X'), variable('Z')]),
      body: [atom('edge', [variable('X'), constant('hub')]), atom('is_a', [constant('hub'), variable('Z')])],
    }),
    createRule({
      id: 'rule:type-inherit',
      head: atom('affects', [variable('X'), variable('Z')]),
      body: [atom('CAUSES', [variable('X'), constant('hub')]), atom('is_a', [constant('hub'), variable('Z')])],
    }),
  ];
}

function buildFacts(n) {
  const facts = [fact('is_a', 'hub', 'disease')];
  for (let i = 0; i < n; i += 1) {
    facts.push(fact('edge', `n${i}`, 'hub'));
    facts.push(fact('CAUSES', `n${i}`, 'hub'));
  }
  return facts;
}

// Minimal snapshot the record builder reads: graphSnapshotId + per-fact detail
// with provenance/source refs. Seeds are the only source here.
function buildSnapshot(facts) {
  return {
    graphSnapshotId: `g:${facts.length}`,
    facts,
    details: facts.map((f) => ({ fact: f, provenanceRefs: ['seed'], sourceRefs: ['seed'], state: 'active' })),
  };
}

function measureSize(n) {
  const rules = buildRules();
  const facts = buildFacts(n);
  const snapshot = buildSnapshot(facts);
  const at = '2026-01-01T00:00:00.000Z';

  const evalStart = process.hrtime.bigint();
  const evaluation = evaluateSemiNaive(rules, facts, { timeoutMs: 30000 });
  const evaluationMs = Number(process.hrtime.bigint() - evalStart) / 1e6;

  const buildStart = process.hrtime.bigint();
  const records = buildRecords(evaluation, snapshot, 'rule-catalog-v1', WORKSPACE, at);
  const buildMs = Number(process.hrtime.bigint() - buildStart) / 1e6;

  const ids = records.map((r) => r.derivationId);
  const uniqueIds = new Set(ids).size;
  const totalBytes = Buffer.byteLength(JSON.stringify(records), 'utf8');

  // A second build from the same inputs must produce the same ids: that is what
  // makes the record idempotent under re-derivation.
  const secondIds = new Set(buildRecords(evaluation, snapshot, 'rule-catalog-v1', WORKSPACE, at)
    .map((r) => r.derivationId));
  const rerunStable = ids.length > 0 && ids.every((id) => secondIds.has(id));

  return {
    facts: facts.length,
    candidates: evaluation.derivedCandidates.length,
    records: records.length,
    uniqueIds,
    duplicateIds: records.length - uniqueIds,
    duplicateSuppressed: evaluation.stats.duplicateSuppressed || 0,
    evaluationMs: Number(evaluationMs.toFixed(2)),
    buildMs: Number(buildMs.toFixed(2)),
    recordOverEvaluationRatio: evaluationMs > 0 ? Number((buildMs / evaluationMs).toFixed(3)) : null,
    totalBytes,
    bytesPerRecord: records.length ? Math.round(totalBytes / records.length) : 0,
    rerunStable,
  };
}

// Same fact derivable by two rules: the engine must emit it once.
function measureCrossRuleDedup() {
  const rules = [
    createRule({ id: 'rule:a-to-c', head: atom('c', [variable('X')]), body: [atom('a', [variable('X')])] }),
    createRule({ id: 'rule:b-to-c', head: atom('c', [variable('X')]), body: [atom('b', [variable('X')])] }),
  ];
  const evaluation = evaluateSemiNaive(rules, [fact('a', 'n1'), fact('b', 'n1')], { timeoutMs: 10000 });
  const keys = evaluation.derivedCandidates.map((c) => factKey(c.fact));
  return {
    candidates: evaluation.derivedCandidates.length,
    uniqueFactKeys: new Set(keys).size,
    duplicateSuppressed: evaluation.stats.duplicateSuppressed || 0,
  };
}

// Replays the runtime's merge loop across K successive graph growths, where
// each step adds one fact and therefore a new graph snapshot id. The merge loop
// keys carried records by derivationId; because that id embeds the snapshot,
// the same logical derivation is re-issued every step instead of colliding.
function measureCrossSnapshotGrowth(steps) {
  const rules = [createRule({ id: 'rule:q-from-p', head: atom('q', [variable('X')]), body: [atom('p', [variable('X')])] })];
  const at = '2026-01-01T00:00:00.000Z';
  let carried = [];
  const growth = [];
  for (let k = 1; k <= steps; k += 1) {
    const facts = [];
    for (let i = 0; i < k; i += 1) facts.push(fact('p', `n${i}`));
    const snapshot = buildSnapshot(facts);
    carried = reconcile(carried, snapshot, at);
    const evaluation = evaluateSemiNaive(rules, facts, { timeoutMs: 10000 });
    const derived = buildRecords(evaluation, snapshot, 'rule-catalog-v1', WORKSPACE, at);
    const merged = new Map(carried.map((r) => [r.derivationId, r]));
    for (const record of derived) if (!merged.has(record.derivationId)) merged.set(record.derivationId, record);
    carried = [...merged.values()];
    growth.push({ snapshot: k, facts: k, records: carried.length });
  }
  return growth;
}

function main() {
  const sizes = parseSizes();
  const perSize = sizes.map(measureSize);
  if (perSize.every((row) => row.candidates === 0)) {
    throw new Error('fixture derived no candidates; the cost numbers would be meaningless');
  }
  const report = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    workload: 'evaluateSemiNaive (reachable + type-inherit) then buildRecords',
    sizes,
    perSize,
    crossRuleDedup: measureCrossRuleDedup(),
    crossSnapshotGrowth: measureCrossSnapshotGrowth(8),
    // The record id is a deterministic hash, so "do not store a duplicate" is a
    // lookup by derivationId, not a new dedup mechanism.
    idempotencyKey: 'derivationId (sha256 over workspaceId+fact+ruleId+bindings+supports+snapshot)',
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (require.main === module) {
  main();
}

module.exports = {
  buildRules,
  buildFacts,
  buildSnapshot,
  measureSize,
  measureCrossRuleDedup,
  measureCrossSnapshotGrowth,
  DEFAULT_SIZES,
};
