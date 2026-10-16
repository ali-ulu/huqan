'use strict';

// The four read-only report commands of huqan-gate-hook, driven in-process.
// Exit-code contract (lib/gate-hook-reports.js): seals exits 1 on a broken or
// untrusted chain; fleet, residency and command-proposals always exit 0.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  runSealsCommand,
  runFleetCommand,
  runResidencyCommand,
  runCommandProposalsCommand,
} = require('../lib/gate-hook-reports');
const { buildReceiptBatch } = require('../lib/external-action-receipt-shipper');
const { ingestReceiptBatch } = require('../lib/external-action-receipt-collector');

const TENANT = Object.freeze({ workspaceId: 'default', ownerActorId: 'acme' });

function scratch(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-reports-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return base;
}

function receipt(id) {
  return {
    schemaVersion: 'v4-receipt-v1',
    receiptId: id,
    receiptKind: 'external_action_admission_receipt',
    decision: 'allow',
    verdict: 'allow',
    workspaceId: TENANT.workspaceId,
    actor: 'demo-agent',
    createdAt: '2026-09-05T00:00:00.000Z',
    metadata: { identity: { identityRef: 'agent:default:demo-agent', agentId: 'demo-agent', ownerActorId: TENANT.ownerActorId, attested: false } },
  };
}

// Runs one command with its own argv and returns { report, exitCode }.
function run(command, args) {
  const savedArgv = process.argv;
  const savedWrite = process.stdout.write;
  const savedExitCode = process.exitCode;
  let out = '';
  process.argv = [process.execPath, 'huqan-gate-hook', ...args];
  process.stdout.write = (chunk) => { out += chunk; return true; };
  try {
    command();
    return { report: JSON.parse(out), exitCode: process.exitCode };
  } finally {
    process.argv = savedArgv;
    process.stdout.write = savedWrite;
    process.exitCode = savedExitCode;
  }
}

test('seals exits 0 on an empty store and 1 when a sealed chain is not trusted', (t) => {
  const empty = run(runSealsCommand, ['--store', scratch(t)]);
  assert.deepEqual(empty.report, { ok: true, tenants: [] });
  assert.equal(empty.exitCode, 0);

  const store = scratch(t);
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  ingestReceiptBatch({
    batch: buildReceiptBatch({ tenant: TENANT, receipts: [receipt('xact_1')] }),
    root: store,
    sealKey: { keyReference: 'collector-1', privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
  });
  const untrusted = run(runSealsCommand, ['--store', store, '--workspace', 'default', '--owner', 'acme']);
  assert.equal(untrusted.report.ok, false);
  assert.equal(untrusted.report.tenants[0].reason, 'seal_key_not_trusted');
  assert.equal(untrusted.exitCode, 1, 'a silent audit is not an audit: an untrusted chain must fail the exit code');
});

test('fleet always exits 0 and honours every filter flag', (t) => {
  const store = scratch(t);
  ingestReceiptBatch({ batch: buildReceiptBatch({ tenant: TENANT, receipts: [receipt('xact_1'), receipt('xact_2')] }), root: store });

  const all = run(runFleetCommand, ['--store', store]);
  assert.equal(all.exitCode, 0);
  assert.equal(all.report.scanned, 2);

  assert.equal(all.report.agents.length, 1);

  const inWindow = run(runFleetCommand, [
    '--store', store, '--workspace', 'default', '--owner', 'acme',
    '--since', '2026-09-01T00:00:00.000Z', '--until', '2026-09-30T00:00:00.000Z', '--limit', '1',
  ]);
  assert.equal(inWindow.exitCode, 0);
  assert.equal(inWindow.report.agents.length, 1);
  assert.equal(inWindow.report.agents[0].total, 2);

  const outOfWindow = run(runFleetCommand, ['--store', store, '--since', '2026-09-10T00:00:00.000Z']);
  assert.equal(outOfWindow.exitCode, 0);
  assert.equal(outOfWindow.report.scanned, 2, 'out-of-window receipts are still scanned');
  assert.deepEqual(outOfWindow.report.agents, [], 'but they are not counted');
});

test('residency always exits 0 and passes --min-observations through', (t) => {
  const dir = scratch(t);
  const plain = run(runResidencyCommand, ['--receipt-log', path.join(dir, 'missing.jsonl')]);
  assert.equal(plain.exitCode, 0);
  assert.equal(plain.report.receiptsRead, 0);
  assert.equal(plain.report.proposal, null);

  const tuned = run(runResidencyCommand, ['--receipt-log', path.join(dir, 'missing.jsonl'), '--min-observations', '7']);
  assert.equal(tuned.report.minObservations, 7);
});

test('command-proposals reads the shape log beside the trail unless one is named', (t) => {
  const dir = scratch(t);
  const trail = path.join(dir, 'receipts.jsonl');
  const named = path.join(dir, 'elsewhere-shapes.jsonl');

  const beside = run(runCommandProposalsCommand, ['--receipt-log', trail]);
  assert.equal(beside.exitCode, 0);
  assert.notEqual(beside.report.shapeLog, named);
  assert.equal(path.dirname(beside.report.shapeLog), dir);

  const explicit = run(runCommandProposalsCommand, ['--receipt-log', trail, '--shape-log', named, '--min-observations', '4']);
  assert.equal(explicit.exitCode, 0);
  assert.equal(explicit.report.shapeLog, named);
  assert.equal(explicit.report.receiptsRead, 0);
  assert.equal(explicit.report.shapesRead, 0);
});

test('without --receipt-log both trail readers fall back to the gate default trail', (t) => {
  // HUQAN_EXTERNAL_GUARD_RECEIPTS is the default trail's override; pointing it
  // at a scratch file keeps the test away from the operator's real receipts.
  const dir = scratch(t);
  const trail = path.join(dir, 'default-trail.jsonl');
  const saved = process.env.HUQAN_EXTERNAL_GUARD_RECEIPTS;
  process.env.HUQAN_EXTERNAL_GUARD_RECEIPTS = trail;
  t.after(() => {
    if (saved === undefined) delete process.env.HUQAN_EXTERNAL_GUARD_RECEIPTS;
    else process.env.HUQAN_EXTERNAL_GUARD_RECEIPTS = saved;
  });

  const residency = run(runResidencyCommand, []);
  assert.equal(residency.exitCode, 0);
  assert.equal(residency.report.receiptsRead, 0);

  const proposals = run(runCommandProposalsCommand, []);
  assert.equal(proposals.exitCode, 0);
  assert.equal(path.dirname(proposals.report.shapeLog), dir, 'the shape log is resolved beside the default trail');
});
