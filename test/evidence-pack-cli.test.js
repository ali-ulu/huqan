'use strict';

/**
 * #4092 PR-A2 -- `huqan evidence pack` then `huqan evidence verify`, through the
 * real CLI entry point (cli.js as a child process), with ambient stores found
 * the way an operator's shell finds them: environment variables and the cwd.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const Graph = require('../graph');
const { createEmergencyStop } = require('../lib/emergency-stop');

const CLI = path.join(__dirname, '..', 'cli.js');
const VERIFIER = path.join(__dirname, '..', 'specs', 'huqan-evidence-pack', '0.1', 'verify_pack.py');
const BASE = Date.parse('2026-01-10T00:00:00.000Z');

function receipt(index) {
  return {
    receiptId: `receipt-cli-${index}`,
    receiptKind: 'memory_admission',
    decision: 'allow',
    status: 'accepted',
    admissionId: `admission-cli-${index}`,
    workspaceId: 'default',
    actor: 'cli-test',
    agentId: 'agent-cli',
    memoryDraftId: `draft-cli-${index}`,
    provenanceId: `prov-cli-${index}`,
    trustPolicyVersion: 'cli-test-v1',
    approvalId: '',
    approvalStatus: '',
    reason: 'accepted',
    riskScore: 0,
    createdAt: new Date(BASE + index * 1000).toISOString(),
    metadata: {},
  };
}

function seededHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-a2-cli-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const memoryPath = path.join(home, 'memory.json');
  const dbPath = path.join(home, 'memory.db');
  const graph = new Graph({ memoryPath, dbPath, useSQLite: true });
  for (let i = 1; i <= 2; i += 1) {
    graph.appendAuditEvent({
      auditId: `audit-cli-${i}`,
      eventType: 'LEARN',
      targetType: 'edge',
      targetId: `a-${i}|is_a|b-${i}`,
      workspaceId: 'default',
      actor: 'cli-test',
      timestamp: new Date(BASE + i * 1000).toISOString(),
      sourceRef: 'test:cli',
      provenanceId: `prov-audit-cli-${i}`,
      trustPolicyVersion: 'cli-test-v1',
      details: { receipt: receipt(i) },
    });
  }
  graph.close();
  const stopDir = path.join(home, 'stops');
  const stop = createEmergencyStop({ directory: stopDir, now: () => '2026-01-11T00:00:00.000Z' });
  stop.stop({ scope: 'workspace', workspaceId: 'default', reason: 'drill', actor: 'operator:test' });
  const env = {
    ...process.env,
    HUQAN_MEMORY_PATH: memoryPath,
    HUQAN_DB_PATH: dbPath,
    HUQAN_EMERGENCY_STOP_DIR: stopDir,
    HUQAN_EXTERNAL_GUARD_RECEIPTS: path.join(home, 'external.jsonl'),
    HUQAN_BACKUP_DIR: path.join(home, 'backups'),
  };
  delete env.HUQAN_ISSUER_SEAL_KEY;
  return { home, env };
}

function huqan(args, { home, env }) {
  return spawnSync(process.execPath, [CLI, ...args], { cwd: home, env, encoding: 'utf8' });
}

test('pack then verify round-trips via real CLI entry', (t) => {
  const ctx = seededHome(t);
  const out = path.join(ctx.home, 'evidence-pack');
  const pack = huqan(['evidence', 'pack', '--from', '2026-01-01T00:00:00.000Z', '--to', '2026-01-31T23:59:59.999Z', '--out', out], ctx);
  assert.equal(pack.status, 0, pack.stdout + pack.stderr);
  assert.match(pack.stdout, /packHash: [0-9a-f]{64}/);

  const verify = huqan(['evidence', 'verify', out], ctx);
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /^VALID/);
  assert.match(verify.stdout, /receipts\/receipt-bundle\.json {2}hash_chained/);
  assert.match(verify.stdout, /audit\/audit-events\.jsonl {2}snapshot_hash_only/);
  assert.match(verify.stdout, /non-claim: a valid pack is not a SOC 2 report/);

  const bundle = JSON.parse(fs.readFileSync(path.join(out, 'receipts', 'receipt-bundle.json'), 'utf8'));
  assert.equal(bundle.receiptCount, 2);
  assert.ok(fs.existsSync(path.join(out, 'emergency-stop', 'ledger.jsonl')));

  const json = huqan(['evidence', 'verify', out, '--json'], ctx);
  assert.equal(json.status, 0);
  assert.equal(JSON.parse(json.stdout).data.valid, true);

  // One changed byte: the same CLI now exits non-zero and says why.
  const bundlePath = path.join(out, 'receipts', 'receipt-bundle.json');
  const bytes = fs.readFileSync(bundlePath);
  bytes[bytes.indexOf(Buffer.from('receipts'))] ^= 1;
  fs.writeFileSync(bundlePath, bytes);
  const tampered = huqan(['evidence', 'verify', out], ctx);
  assert.notEqual(tampered.status, 0);
  assert.match(tampered.stdout, /^INVALID/);
  assert.match(tampered.stdout, /file_hash_mismatch:receipts\/receipt-bundle\.json/);
});

test('the python verifier accepts a pack the CLI wrote', (t) => {
  const probe = spawnSync(process.platform === 'win32' ? 'py' : 'python3', process.platform === 'win32' ? ['-3', '--version'] : ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) return t.skip('no python interpreter');
  const ctx = seededHome(t);
  const out = path.join(ctx.home, 'evidence-pack');
  assert.equal(huqan(['evidence', 'pack', '--from', '2026-01-01', '--to', '2026-01-31T23:59:59.999Z', '--out', out], ctx).status, 0);
  const args = process.platform === 'win32' ? ['-3', VERIFIER, out] : [VERIFIER, out];
  const run = spawnSync(process.platform === 'win32' ? 'py' : 'python3', args, { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stdout + run.stderr);
});

test('pack refuses bad input with exit 2 and writes nothing', (t) => {
  const ctx = seededHome(t);
  const out = path.join(ctx.home, 'evidence-pack');
  const missing = huqan(['evidence', 'pack', '--from', '2026-01-01', '--out', out], ctx);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /INVALID_INPUT/);
  const reversed = huqan(['evidence', 'pack', '--from', '2026-02-01', '--to', '2026-01-01', '--out', out], ctx);
  assert.equal(reversed.status, 2);
  assert.match(reversed.stderr, /PERIOD_INVALID/);
  const otherWorkspace = huqan(['evidence', 'pack', '--from', '2026-01-01', '--to', '2026-01-31', '--out', out, '--workspace', 'other'], ctx);
  assert.equal(otherWorkspace.status, 2);
  assert.match(otherWorkspace.stderr, /WORKSPACE_NOT_ALLOWED/);
  assert.equal(fs.existsSync(out), false);
  assert.equal(huqan(['evidence'], ctx).status, 2);
});

test('a flag operand that is another flag is invalid input, not a directory named after the flag', (t) => {
  const ctx = seededHome(t);
  const run = huqan(['evidence', 'pack', '--from', '2026-01-01', '--to', '2026-01-31', '--out', '--workspace', 'default'], ctx);
  assert.equal(run.status, 2);
  assert.match(run.stderr, /--out needs a value/);
  assert.equal(fs.existsSync(path.join(ctx.home, '--workspace')), false);
});

test('pack --sign writes a signature with the configured issuer key; without a key it is unsigned, not a failure', (t) => {
  const ctx = seededHome(t);
  const period = ['--from', '2026-01-01', '--to', '2026-01-31T23:59:59.999Z'];

  const unsignedOut = path.join(ctx.home, 'unsigned-pack');
  const unsigned = huqan(['evidence', 'pack', ...period, '--out', unsignedOut, '--sign'], ctx);
  assert.equal(unsigned.status, 0, unsigned.stdout + unsigned.stderr);
  assert.match(unsigned.stdout, /unsigned: no issuer key is configured/);
  assert.equal(fs.existsSync(path.join(unsignedOut, 'manifest.signature.json')), false);
  assert.match(huqan(['evidence', 'verify', unsignedOut], ctx).stdout, /signature: unsigned/);

  const keyPath = path.join(ctx.home, 'issuer.pem');
  fs.writeFileSync(keyPath, crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const signedCtx = { ...ctx, env: { ...ctx.env, HUQAN_ISSUER_SEAL_KEY: keyPath } };
  const signedOut = path.join(ctx.home, 'signed-pack');
  const signed = huqan(['evidence', 'pack', ...period, '--out', signedOut, '--sign'], signedCtx);
  assert.equal(signed.status, 0, signed.stdout + signed.stderr);
  assert.match(signed.stdout, /signed: ed25519:[0-9a-f]{32}/);
  const verify = huqan(['evidence', 'verify', signedOut], ctx);
  assert.equal(verify.status, 0, verify.stdout + verify.stderr);
  assert.match(verify.stdout, /signature: signed {2}keyId: ed25519:[0-9a-f]{32}/);
  assert.match(verify.stdout, /proves origin, not independence/);

  // Without --sign a configured key is not used.
  const plainOut = path.join(ctx.home, 'plain-pack');
  assert.equal(huqan(['evidence', 'pack', ...period, '--out', plainOut], signedCtx).status, 0);
  assert.equal(fs.existsSync(path.join(plainOut, 'manifest.signature.json')), false);
});

test('pack --collector-store packs the seal chain; verify takes the keys from --collector-pubkeys', (t) => {
  const { collectorStore } = require('./helpers/evidence-pack-fixtures');
  const ctx = seededHome(t);
  const collector = collectorStore(ctx.home);
  const period = ['--from', '2026-01-01', '--to', '2026-01-31T23:59:59.999Z'];

  const noKeys = huqan(['evidence', 'pack', ...period, '--out', path.join(ctx.home, 'refused'), '--collector-store', collector.store], ctx);
  assert.equal(noKeys.status, 2);
  assert.match(noKeys.stderr, /COLLECTOR_PUBKEYS_REQUIRED/);
  assert.equal(fs.existsSync(path.join(ctx.home, 'refused')), false);

  const out = path.join(ctx.home, 'sealed-pack');
  const pack = huqan(['evidence', 'pack', ...period, '--out', out, '--collector-store', collector.store, '--collector-pubkeys', collector.pubkeys], ctx);
  assert.equal(pack.status, 0, pack.stdout + pack.stderr);
  assert.match(pack.stdout, /collector-seals\.jsonl/.source ? /./ : /./);

  const withKeys = huqan(['evidence', 'verify', out, '--collector-pubkeys', collector.pubkeys], ctx);
  assert.equal(withKeys.status, 0, withKeys.stdout + withKeys.stderr);
  assert.match(withKeys.stdout, /external-actions\/collector-seals\.jsonl {2}counter_sealed/);
  assert.doesNotMatch(withKeys.stdout, /warning:/);

  const withoutKeys = huqan(['evidence', 'verify', out], ctx);
  assert.equal(withoutKeys.status, 0);
  assert.match(withoutKeys.stdout, /warning: collector seals present, not verified: no collector public key supplied/);

  // Another host's key directory (same key name, different key) does not verify the seals.
  const other = collectorStore(fs.mkdtempSync(path.join(ctx.home, 'other-')));
  const wrongKeys = huqan(['evidence', 'verify', out, '--collector-pubkeys', other.pubkeys], ctx);
  assert.notEqual(wrongKeys.status, 0);
  assert.match(wrongKeys.stdout, /collector_seal_chain_invalid:seal_signature_invalid/);
});
