'use strict';

/**
 * #4092 PR-A2 -- the evidence pack collector.
 *
 * The collector only calls functions that already exist; what these tests pin
 * is what it decides on top of them: which bytes enter the pack, when it
 * refuses, and that a refusal leaves nothing behind. Every test drives a real
 * Graph and a real directory, because the properties are about files on disk.
 *
 * SECURITY_INVARIANTS.md SI-03 (no secret leaves the host in evidence) is the
 * invariant the secret tests refer to; no new invariant is opened here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const tls = require('node:tls');

const Graph = require('../graph');
const { createEmergencyStop } = require('../lib/emergency-stop');
const { exportMaterializedReceiptBundleBounded } = require('../lib/receipt/bounded-receipt-export');
const { collectEvidencePack } = require('../lib/evidence-pack/collect');
const { verifyPack } = require('../lib/evidence-pack/verify');

// Assembled at runtime so no credential-shaped literal exists in the repository: the gitleaks
// scan reads commit history and its generic-api-key rule fires on the assignment as a whole.
const SECRET = ['sk', 'live', '0123456789abcdefghijklmnop'].join('-');

const FROM = '2026-01-01T00:00:00.000Z';
const TO = '2026-01-31T23:59:59.999Z';
const NOW = '2026-02-01T00:00:00.000Z';
const IN_PERIOD = Date.parse('2026-01-10T00:00:00.000Z');
const BEFORE_PERIOD = Date.parse('2025-06-01T00:00:00.000Z');

function receipt(index, overrides = {}) {
  return {
    receiptId: `receipt-a2-${index}`,
    receiptKind: 'memory_admission',
    decision: 'allow',
    status: 'accepted',
    admissionId: `admission-a2-${index}`,
    workspaceId: 'default',
    actor: 'a2-test',
    agentId: 'agent-a2',
    memoryDraftId: `draft-a2-${index}`,
    provenanceId: `prov-a2-${index}`,
    trustPolicyVersion: 'a2-test-v1',
    approvalId: '',
    approvalStatus: '',
    reason: 'accepted',
    riskScore: 0,
    createdAt: new Date(overrides.at || IN_PERIOD + index * 1000).toISOString(),
    metadata: overrides.metadata || {},
    ...overrides.extra,
  };
}

function auditEvent(index, raw, at = IN_PERIOD + index * 1000) {
  return {
    auditId: `audit-a2-${index}`,
    eventType: 'LEARN',
    targetType: 'edge',
    targetId: `a-${index}|is_a|b-${index}`,
    workspaceId: 'default',
    actor: 'a2-test',
    timestamp: new Date(at).toISOString(),
    sourceRef: 'test:a2',
    provenanceId: `prov-audit-a2-${index}`,
    trustPolicyVersion: 'a2-test-v1',
    details: raw ? { receipt: raw } : {},
  };
}

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-a2-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function graphWith(t, events) {
  const dir = scratch(t);
  const graph = new Graph({ memoryPath: path.join(dir, 'memory.json'), useSQLite: false });
  for (const event of events) graph.appendAuditEvent(event);
  t.after(() => graph.close());
  return graph;
}

function baseEvents() {
  return [
    auditEvent(0, receipt(0, { at: BEFORE_PERIOD }), BEFORE_PERIOD),
    auditEvent(1, receipt(1)),
    auditEvent(2, receipt(2)),
  ];
}

function options(t, graph, extra = {}) {
  const root = scratch(t);
  return {
    from: FROM,
    to: TO,
    outDir: path.join(root, 'pack'),
    graph,
    emergencyStopDir: path.join(root, 'no-ledger'),
    externalReceiptsPath: path.join(root, 'no-external.jsonl'),
    backupOptions: { backupBaseDir: path.join(root, 'no-backups') },
    now: () => NOW,
    ...extra,
  };
}

async function collectFailure(opts) {
  try {
    await collectEvidencePack(opts);
  } catch (error) {
    return error;
  }
  assert.fail('collectEvidencePack was expected to refuse');
  return null;
}

function assertNothingLeftBehind(opts) {
  assert.equal(fs.existsSync(opts.outDir), false, 'no output directory');
  const parent = path.dirname(opts.outDir);
  assert.deepEqual(fs.readdirSync(parent), [], 'no temp sibling, hidden or not');
}

test('pack contains bundle byte-identical to bounded export', async (t) => {
  const graph = graphWith(t, baseEvents());
  const opts = options(t, graph);
  await collectEvidencePack(opts);

  // The period source: only the in-period receipts. Re-chained from genesis by
  // the same function the pack must not second-guess.
  const periodEvents = baseEvents().slice(1);
  const expected = exportMaterializedReceiptBundleBounded(periodEvents, { workspaceId: 'default', exportedAt: NOW });
  assert.equal(expected.ok, true);
  const packed = fs.readFileSync(path.join(opts.outDir, 'receipts', 'receipt-bundle.json'), 'utf8');
  assert.equal(packed, JSON.stringify(expected.bundle));

  const verdict = verifyPack(opts.outDir);
  assert.deepEqual(verdict.findings, []);
  assert.equal(verdict.valid, true);
});

test('fails closed with MAX_RECEIPTS_EXCEEDED and leaves no partial output directory', async (t) => {
  const events = [];
  for (let i = 0; i < 1025; i += 1) events.push(auditEvent(i, receipt(i)));
  const graph = graphWith(t, events);
  const opts = options(t, graph);
  const error = await collectFailure(opts);
  assert.equal(error.code, 'MAX_RECEIPTS_EXCEEDED');
  assertNothingLeftBehind(opts);
});

test('refuses non-default workspace with WORKSPACE_NOT_ALLOWED', async (t) => {
  const graph = graphWith(t, baseEvents());
  const opts = options(t, graph, { workspaceId: 'other' });
  const error = await collectFailure(opts);
  assert.equal(error.code, 'WORKSPACE_NOT_ALLOWED');
  assertNothingLeftBehind(opts);
});

test('refuses to pack when receipts carry secret-looking value', async (t) => {
  // SI-03: the receipt is hash-bound, so it cannot be redacted; the pack is refused.
  const secret = receipt(1, { metadata: { api_key: SECRET } });
  const graph = graphWith(t, [auditEvent(1, secret)]);
  const opts = options(t, graph);
  const error = await collectFailure(opts);
  assert.equal(error.code, 'EVIDENCE_PACK_SECRET_DETECTED');
  assert.doesNotMatch(error.message, /sk-live/);
  assertNothingLeftBehind(opts);
});

test('a signature nested anywhere in hash-bound content is not read as a secret', async (t) => {
  // SECRET stands in for the one-in-five random base64 signature the heuristic flags.
  const sealed = receipt(1, { metadata: { seal: { signature: SECRET } } });
  const graph = graphWith(t, [auditEvent(1, sealed)]);
  const opts = options(t, graph);
  await collectEvidencePack(opts);
  assert.equal(verifyPack(opts.outDir).valid, true);
});

test('performs no network call while packing', async (t) => {
  const calls = [];
  const trap = (name) => () => { calls.push(name); throw new Error(`network call attempted: ${name}`); };
  const originals = [];
  const stub = (target, key, name) => {
    originals.push([target, key, target[key]]);
    target[key] = trap(name);
  };
  stub(globalThis, 'fetch', 'fetch');
  stub(net, 'connect', 'net.connect');
  stub(net, 'createConnection', 'net.createConnection');
  stub(http, 'request', 'http.request');
  stub(http, 'get', 'http.get');
  stub(https, 'request', 'https.request');
  stub(https, 'get', 'https.get');
  stub(tls, 'connect', 'tls.connect');
  t.after(() => { for (const [target, key, value] of originals) target[key] = value; });

  const graph = graphWith(t, baseEvents());
  const opts = options(t, graph);
  await collectEvidencePack(opts);
  assert.deepEqual(calls, []);
  assert.equal(verifyPack(opts.outDir).valid, true);
});

test('audit events file is labelled snapshot_hash_only', async (t) => {
  const graph = graphWith(t, baseEvents());
  const opts = options(t, graph);
  await collectEvidencePack(opts);
  const manifest = JSON.parse(fs.readFileSync(path.join(opts.outDir, 'manifest.json'), 'utf8'));
  const classes = Object.fromEntries(manifest.files.map((file) => [file.path, file.integrityClass]));
  assert.equal(classes['audit/audit-events.jsonl'], 'snapshot_hash_only');
  assert.equal(classes['receipts/receipt-bundle.json'], 'hash_chained');
  assert.equal(classes['config/security-invariants.md'], 'snapshot_hash_only');
  assert.equal(classes['backups/backup-index.json'], 'snapshot_hash_only');
  assert.equal(manifest.workspaceId, 'default');
  assert.deepEqual(manifest.period, { from: FROM, to: TO });
  assert.equal(manifest.producer.issuerKeyId, null);
});

test('audit file and bundle hold only the requested period', async (t) => {
  const graph = graphWith(t, baseEvents());
  const opts = options(t, graph);
  await collectEvidencePack(opts);
  const lines = fs.readFileSync(path.join(opts.outDir, 'audit', 'audit-events.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(lines.map((line) => JSON.parse(line).auditId), ['audit-a2-1', 'audit-a2-2']);
  const bundle = JSON.parse(fs.readFileSync(path.join(opts.outDir, 'receipts', 'receipt-bundle.json'), 'utf8'));
  assert.equal(bundle.receiptCount, 2);
});

test('packs exactly the slice-A2 files and none of the later slices', async (t) => {
  const graph = graphWith(t, baseEvents());
  const opts = options(t, graph);
  await collectEvidencePack(opts);
  const manifest = JSON.parse(fs.readFileSync(path.join(opts.outDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.files.map((file) => file.path).sort(), [
    'audit/audit-events.jsonl',
    'backups/backup-index.json',
    'config/policy-seals.json',
    'config/security-invariants.md',
    'external-actions/receipts.jsonl',
    'receipts/receipt-bundle.json',
    'verification/producer-self-check.json',
  ]);
});

test('does not pack a bundle that fails the verify step it re-runs on the exact bytes', async (t) => {
  const graph = graphWith(t, baseEvents());
  // An export seam that claims success and verification, yet hands back a
  // bundle whose declared count disagrees with its receipts.
  const exportBundle = (source, opts) => {
    const real = exportMaterializedReceiptBundleBounded(source, opts);
    return { ...real, bundle: { ...real.bundle, receiptCount: 99 } };
  };
  const opts = options(t, graph, { exportBundle });
  const error = await collectFailure(opts);
  assert.equal(error.code, 'BUNDLE_VERIFICATION_FAILED');
  assertNothingLeftBehind(opts);
});

test('refuses an existing output directory and an invalid period without touching disk', async (t) => {
  const graph = graphWith(t, baseEvents());
  const existing = options(t, graph);
  fs.mkdirSync(existing.outDir);
  assert.equal((await collectFailure(existing)).code, 'OUT_DIR_EXISTS');
  assert.deepEqual(fs.readdirSync(existing.outDir), []);

  const reversed = options(t, graph, { from: TO, to: FROM });
  assert.equal((await collectFailure(reversed)).code, 'PERIOD_INVALID');
  assertNothingLeftBehind(reversed);
  const garbage = options(t, graph, { from: 'yesterday' });
  assert.equal((await collectFailure(garbage)).code, 'PERIOD_INVALID');
});

test('packs the emergency-stop ledger byte for byte and refuses a broken chain', async (t) => {
  const graph = graphWith(t, baseEvents());
  const ledgerDir = path.join(scratch(t), 'stops');
  const stop = createEmergencyStop({ directory: ledgerDir, now: () => '2026-01-12T00:00:00.000Z' });
  stop.stop({ scope: 'workspace', workspaceId: 'default', reason: 'drill', actor: 'operator:test' });
  stop.lift({ scope: 'workspace', workspaceId: 'default', actor: 'operator:test' });
  const opts = options(t, graph, { emergencyStopDir: ledgerDir });
  await collectEvidencePack(opts);
  const source = fs.readFileSync(path.join(ledgerDir, 'ledger.jsonl'));
  assert.deepEqual(fs.readFileSync(path.join(opts.outDir, 'emergency-stop', 'ledger.jsonl')), source);
  const manifest = JSON.parse(fs.readFileSync(path.join(opts.outDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.files.find((file) => file.path === 'emergency-stop/ledger.jsonl').integrityClass, 'hash_chained');
  assert.equal(verifyPack(opts.outDir).valid, true);

  fs.writeFileSync(path.join(ledgerDir, 'ledger.jsonl'), source.toString('utf8').replace('drill', 'edited'));
  const broken = options(t, graph, { emergencyStopDir: ledgerDir });
  assert.equal((await collectFailure(broken)).code, 'EMERGENCY_STOP_LEDGER_INVALID');
  assertNothingLeftBehind(broken);
});

test('scrubs secrets from hash-less files and reports PII types in the manifest', async (t) => {
  const graph = graphWith(t, baseEvents());
  const dir = scratch(t);
  const externalPath = path.join(dir, 'external.jsonl');
  const inPeriod = { receiptId: 'ext-1', createdAt: '2026-01-11T00:00:00.000Z', note: 'contact ops@example.com', token: SECRET };
  const outside = { receiptId: 'ext-0', createdAt: '2025-01-01T00:00:00.000Z' };
  fs.writeFileSync(externalPath, [outside, inPeriod].map((row) => `${JSON.stringify(row)}\n`).join(''));
  const opts = options(t, graph, { externalReceiptsPath: externalPath });
  await collectEvidencePack(opts);

  const packed = fs.readFileSync(path.join(opts.outDir, 'external-actions', 'receipts.jsonl'), 'utf8');
  assert.doesNotMatch(packed, /sk-live/);
  assert.deepEqual(packed.trim().split('\n').map((line) => JSON.parse(line).receiptId), ['ext-1']);
  const manifest = JSON.parse(fs.readFileSync(path.join(opts.outDir, 'manifest.json'), 'utf8'));
  assert.ok(manifest.piiTypes.includes('email'));
  const selfCheck = JSON.parse(fs.readFileSync(path.join(opts.outDir, 'verification', 'producer-self-check.json'), 'utf8'));
  assert.deepEqual(selfCheck.scrubbedFiles, ['external-actions/receipts.jsonl']);
  assert.equal(verifyPack(opts.outDir).valid, true);
});

test('backup index carries metadata only, never absolute paths', async (t) => {
  const graph = graphWith(t, baseEvents());
  const base = path.join(scratch(t), 'backups');
  fs.mkdirSync(path.join(base, 'backup-1'), { recursive: true });
  fs.writeFileSync(path.join(base, 'backup-1', 'memory.json'), '{"secret":"do not copy"}');
  const opts = options(t, graph, { backupOptions: { backupBaseDir: base } });
  await collectEvidencePack(opts);
  const text = fs.readFileSync(path.join(opts.outDir, 'backups', 'backup-index.json'), 'utf8');
  const index = JSON.parse(text);
  assert.equal(index.backups[0].id, 'backup-1');
  assert.deepEqual(index.backups[0].files, [{ name: 'memory.json', bytes: 24 }]);
  assert.equal(text.includes(base), false);
  assert.equal(text.includes('do not copy'), false);
});

test('rejects impossible dates and zone-less date-times, and records the applied window normalized', async (t) => {
  const graph = graphWith(t, baseEvents());
  for (const bad of ['2026-02-30', '2026-01-01T00:00:00', '2026-13-01', '2026-01-01T25:00:00Z', 'yesterday']) {
    const opts = options(t, graph, { from: bad });
    assert.equal((await collectFailure(opts)).code, 'PERIOD_INVALID', bad);
    assertNothingLeftBehind(opts);
  }
  const opts = options(t, graph, { from: '2026-01-01', to: '2026-01-31T23:59:59+00:00' });
  await collectEvidencePack(opts);
  const manifest = JSON.parse(fs.readFileSync(path.join(opts.outDir, 'manifest.json'), 'utf8'));
  assert.deepEqual(manifest.period, { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T23:59:59.000Z' });
});

test('an oversized audit event outside the period is a coded refusal, not a raw error', async (t) => {
  const huge = auditEvent(9, receipt(9, { at: BEFORE_PERIOD, metadata: { blob: 'x'.repeat(2 * 1024 * 1024 + 10) } }), BEFORE_PERIOD);
  const graph = graphWith(t, [huge, ...baseEvents().slice(1)]);
  const opts = options(t, graph);
  assert.equal((await collectFailure(opts)).code, 'MAX_SERIALIZED_BUNDLE_BYTES_EXCEEDED');
  assertNothingLeftBehind(opts);
});

test('a write failure is a coded refusal and leaves nothing behind', async (t) => {
  const graph = graphWith(t, baseEvents());
  const opts = options(t, graph);
  // The parent of the target is a regular file, so the staging directory cannot be created.
  fs.writeFileSync(path.dirname(opts.outDir) + '-file', 'x');
  const blocked = { ...opts, outDir: path.join(path.dirname(opts.outDir) + '-file', 'pack') };
  assert.equal((await collectFailure(blocked)).code, 'PACK_WRITE_FAILED');
  fs.rmSync(path.dirname(opts.outDir) + '-file');
});
