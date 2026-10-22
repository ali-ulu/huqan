'use strict';

/**
 * #4092 PR-A5 -- the collector counter-seal chain inside an evidence pack.
 *
 * The chain rule is the collector's own (`verifyCollectorSealChain`); these tests
 * pin what the pack adds: the chain is packed whole after it verified, the public
 * keys arrive by a separate channel and never travel in the pack, a missing key
 * is reported rather than silently trusted, and the JS and Python verifiers give
 * the same findings, warnings and exit status. Keys are generated at run time.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const Graph = require('../graph');
const { collectEvidencePack, PACK_PATHS } = require('../lib/evidence-pack/collect');
const { verifyPack, MANIFEST_FILE } = require('../lib/evidence-pack/verify');
const { UNVERIFIED_WARNING } = require('../lib/evidence-pack/collector-seals');
const { fileEntry, computePackHash, INTEGRITY_CLASSES } = require('../lib/evidence-pack/manifest');
const { generatedKeyPair, collectorStore } = require('./helpers/evidence-pack-fixtures');

const VERIFIER = path.join(__dirname, '..', 'specs', 'huqan-evidence-pack', '0.1', 'verify_pack.py');
const SEALS = PACK_PATHS.collectorSeals;

function scratch(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-a5-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function packOptions(t, root, extra = {}) {
  const graph = new Graph({ memoryPath: path.join(root, 'memory.json'), useSQLite: false });
  t.after(() => graph.close());
  return {
    from: '2026-01-01T00:00:00.000Z',
    to: '2026-01-31T23:59:59.999Z',
    outDir: path.join(root, 'pack'),
    graph,
    emergencyStopDir: path.join(root, 'no-ledger'),
    externalReceiptsPath: path.join(root, 'no-external.jsonl'),
    backupOptions: { backupBaseDir: path.join(root, 'no-backups') },
    now: () => '2026-02-01T00:00:00.000Z',
    ...extra,
  };
}

function build(t, { store = {}, pack = {} } = {}) {
  const root = scratch(t);
  const collector = collectorStore(root, store);
  const result = collectEvidencePack(packOptions(t, root, { collectorStore: collector.store, collectorPubkeys: collector.pubkeys, ...pack }));
  return { root, collector, result, packDir: result.outDir };
}

/** Rewrite the packed seals file and reseal the manifest, as an operator holding no collector key could. */
function rewriteSeals(packDir, mutate) {
  const file = path.join(packDir, SEALS);
  const next = mutate(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)).map((line) => `${line}\n`).join('');
  fs.writeFileSync(file, next);
  const manifestPath = path.join(packDir, MANIFEST_FILE);
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.files = manifest.files.map((entry) => (entry.path === SEALS ? fileEntry(SEALS, next, INTEGRITY_CLASSES.COUNTER_SEALED) : entry));
  manifest.packHash = computePackHash(manifest);
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
}

function python() {
  const candidates = process.platform === 'win32' ? [['py', ['-3']], ['python', []]] : [['python3', []], ['python', []]];
  for (const [command, prefix] of candidates) {
    const probe = spawnSync(command, [...prefix, '--version'], { encoding: 'utf8' });
    if (!probe.error && probe.status === 0) return { command, prefix };
  }
  return null;
}

/** Both verifiers on one pack; asserts they agree on verdict, findings, warnings and exit status. */
function bothVerifiers(packDir, pubkeys) {
  const js = verifyPack(packDir, pubkeys ? { collectorPubkeys: pubkeys } : {});
  const interpreter = python();
  if (interpreter) {
    const run = spawnSync(interpreter.command, [...interpreter.prefix, VERIFIER, packDir, ...(pubkeys ? ['--collector-pubkeys', pubkeys] : [])], { encoding: 'utf8' });
    assert.equal(run.status, js.valid ? 0 : 1, `exit status\n${run.stdout}${run.stderr}`);
    const verdict = run.stdout.split('\n').find((line) => /\b(VALID|INVALID)\b/.test(line));
    const pythonFindings = /\bINVALID\b/.test(verdict) ? verdict.split(/\bINVALID\b/)[1].split(',').map((item) => item.trim()).filter(Boolean).sort() : [];
    assert.deepEqual(pythonFindings, [...js.findings].sort());
    const pythonWarnings = run.stdout.split('\n').filter((line) => line.includes('warning: ')).map((line) => line.split('warning: ')[1].trim());
    assert.deepEqual(pythonWarnings, js.warnings);
  }
  return js;
}

test('includes collector seal chain and verifies with collector public key', (t) => {
  const { collector, packDir, result } = build(t);
  const entry = result.files.find((file) => file.path === SEALS);
  assert.equal(entry.integrityClass, 'counter_sealed');

  const packed = fs.readFileSync(path.join(packDir, SEALS), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
  assert.deepEqual(packed, collector.chains['owner-a']);

  const verdict = bothVerifiers(packDir, collector.pubkeys);
  assert.equal(verdict.valid, true, verdict.findings.join(','));
  assert.deepEqual(verdict.warnings, []);
  assert.ok(verdict.nonClaims.some((claim) => /administered by someone other than the operator/.test(claim)));

  // The keys that vouch for the seals never travel with them.
  for (const entry of fs.readdirSync(packDir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    assert.doesNotMatch(fs.readFileSync(full, 'utf8'), /BEGIN PUBLIC KEY/, path.relative(packDir, full));
  }
});

test('every tenant chain of the default workspace is packed whole and verified per tenant', (t) => {
  const { collector, packDir } = build(t, { store: { owners: ['owner-a', 'owner-b'], count: 2 } });
  assert.equal(fs.readFileSync(path.join(packDir, SEALS), 'utf8').split('\n').filter(Boolean).length, 4);
  assert.equal(bothVerifiers(packDir, collector.pubkeys).valid, true);
});

test('detects removed seal as chain gap', (t) => {
  const { collector, packDir } = build(t);
  rewriteSeals(packDir, (lines) => lines.filter((_, index) => index !== 1));
  const verdict = bothVerifiers(packDir, collector.pubkeys);
  assert.equal(verdict.valid, false);
  assert.deepEqual(verdict.findings, ['collector_seal_chain_invalid:seal_chain_broken']);
});

test('a seal changed by one byte is a signature finding in both verifiers', (t) => {
  const { collector, packDir } = build(t);
  rewriteSeals(packDir, (lines) => lines.map((line, index) => (index === 2 ? line.replace('"count":3', '"count":4') : line)));
  const verdict = bothVerifiers(packDir, collector.pubkeys);
  assert.deepEqual(verdict.findings, ['collector_seal_chain_invalid:seal_signature_invalid']);
});

test('same key for issuer and collector is reported as non-independent', (t) => {
  const key = generatedKeyPair();
  const { collector, packDir } = build(t, { store: { key }, pack: { issuerKey: { privateKeyPem: key.privateKeyPem } } });
  const verdict = bothVerifiers(packDir, collector.pubkeys);
  assert.equal(verdict.valid, true, verdict.findings.join(','));
  assert.equal(verdict.warnings.length, 1);
  assert.match(verdict.warnings[0], /^collector_not_independent: /);

  const separate = build(t, { pack: { issuerKey: { privateKeyPem: generatedKeyPair().privateKeyPem } } });
  assert.deepEqual(bothVerifiers(separate.packDir, separate.collector.pubkeys).warnings, []);
});

test('without a collector public key the seals are reported unverified, and the pack is not invalid', (t) => {
  const { packDir } = build(t);
  const verdict = bothVerifiers(packDir, null);
  assert.equal(verdict.valid, true);
  assert.deepEqual(verdict.warnings, [UNVERIFIED_WARNING]);
  assert.equal(UNVERIFIED_WARNING, 'collector seals present, not verified: no collector public key supplied');
});

test('a key directory that does not hold the collector key fails the chain instead of passing it', (t) => {
  const { packDir } = build(t);
  const empty = scratch(t);
  assert.deepEqual(bothVerifiers(packDir, empty).findings, ['collector_seal_chain_invalid:seal_key_not_trusted']);
  const other = collectorStore(scratch(t), { keyId: 'collector-key-1' });
  assert.deepEqual(bothVerifiers(packDir, other.pubkeys).findings, ['collector_seal_chain_invalid:seal_signature_invalid']);
});

test('a pack without collector seals is unchanged: no warning, no collector file', (t) => {
  const root = scratch(t);
  const result = collectEvidencePack(packOptions(t, root));
  assert.equal(result.files.some((file) => file.path === SEALS), false);
  assert.deepEqual(bothVerifiers(result.outDir, null).warnings, []);
});

test('a broken chain refuses the pack and leaves nothing behind', (t) => {
  const root = scratch(t);
  const collector = collectorStore(root);
  const sealFile = path.join(collector.store, 'default', 'owner-a', 'seals.jsonl');
  const lines = fs.readFileSync(sealFile, 'utf8').split('\n').filter(Boolean);
  fs.writeFileSync(sealFile, `${[lines[0], lines[2]].join('\n')}\n`);
  const opts = packOptions(t, root, { collectorStore: collector.store, collectorPubkeys: collector.pubkeys });
  assert.throws(() => collectEvidencePack(opts), { code: 'COLLECTOR_SEAL_CHAIN_INVALID' });
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('pack')), []);
});

test('a collector store is refused without public keys, and an empty store is refused', (t) => {
  const root = scratch(t);
  const collector = collectorStore(root);
  assert.throws(() => collectEvidencePack(packOptions(t, root, { collectorStore: collector.store })), { code: 'COLLECTOR_PUBKEYS_REQUIRED' });
  const emptyStore = path.join(root, 'empty-store');
  fs.mkdirSync(emptyStore);
  assert.throws(() => collectEvidencePack(packOptions(t, root, { collectorStore: emptyStore, collectorPubkeys: collector.pubkeys })), { code: 'COLLECTOR_SEALS_NOT_FOUND' });
  assert.deepEqual(fs.readdirSync(root).filter((name) => name.includes('pack')), []);
});
