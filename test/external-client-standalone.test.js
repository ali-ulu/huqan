'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { createRouteFixture } = require('./helpers/external-client-route-fixture');
const { createRouteHarness } = require('./helpers/external-client-route-harness');

const CLIENT = path.join(__dirname, '..', 'scripts', 'external-client.js');
function run(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLIENT, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('exit', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}
function counts(fixture) { const state = fixture.state(); return [state.candidates.length, state.journals.length, state.receipts.length]; }
function write(directory, name, value) { const filename = path.join(directory, name); fs.writeFileSync(filename, JSON.stringify(value)); return filename; }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}
function rehash(receipt) {
  receipt.receiptHash = crypto.createHash('sha256').update(JSON.stringify(canonical({
    ...receipt.canonicalPayload, previousReceiptHash: receipt.previousReceiptHash,
  })), 'utf8').digest('hex');
}
function verifyArgs(fixture, receipt, response, pkg) {
  return ['verify', '--receipt', receipt, '--response', response, '--package', pkg,
    '--identity-subject', fixture.IDS.identitySubject, '--identity-kind', fixture.IDS.identityKind,
    '--workspace', fixture.IDS.workspaceId, '--package-id', fixture.IDS.packageId];
}

test('standalone stdlib client admits over loopback and independently verifies returned receipt artifact', async (t) => {
  const fixture = createRouteFixture(t);
  const harness = await createRouteHarness({ adapter: fixture.adapter });
  t.after(() => harness.close());
  const pkg = fixture.packageValue();
  const input = write(fixture.directory, 'request.json', fixture.envelope(pkg));
  const packageFile = write(fixture.directory, 'package.json', pkg);
  const output = path.join(fixture.directory, 'response.json');
  const admitted = await run(['admit', '--url', `http://127.0.0.1:${harness.port}/api/external-client/packages/admit`,
    '--api-key', harness.apiKey, '--input', input, '--output', output]);
  assert.equal(admitted.status, 0, admitted.stderr);
  const artifact = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(artifact.ok, true);
  assert.deepEqual(counts(fixture), [1, 1, 1]);
  assert.equal(fixture.state().receipts[0].receipt_id, artifact.receiptId);
  const refusedOverwrite = await run(['admit', '--url', `http://127.0.0.1:${harness.port}/api/external-client/packages/admit`,
    '--api-key', harness.apiKey, '--input', input, '--output', output]);
  assert.equal(refusedOverwrite.status, 1);
  assert.equal(refusedOverwrite.stderr, 'output file already exists\n');
  assert.deepEqual(counts(fixture), [1, 1, 1]);
  const durable = fixture.graph.getCommittedMutationReceiptByOperation(artifact.operationId);
  const receiptFile = write(fixture.directory, 'receipt-artifact.json', { receipt: {
    operationId: durable.operationId, receiptId: durable.receiptId,
    workspaceId: durable.workspaceId, canonicalPayload: durable.canonicalPayload,
    previousReceiptHash: durable.previousReceiptHash, receiptHash: durable.receiptHash,
  }, authority: {
    identitySubject: fixture.contexts[0].identity.subject, identityKind: fixture.contexts[0].identity.kind,
    workspaceId: fixture.contexts[0].workspaceId, packageId: fixture.contexts[0].packageId,
    packageHash: fixture.contexts[0].packageHash,
  } });
  const verified = await run(verifyArgs(fixture, receiptFile, output, packageFile));
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(verified.stdout, `verified: ${artifact.receiptId}\n`);

  const beforeReplay = fixture.graph.getCommittedMutationReceiptByOperation(artifact.operationId);
  const replay = await harness.send({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(fixture.envelope(pkg)) });
  assert.equal(replay.statusCode, 409);
  assert.deepEqual(counts(fixture), [1, 1, 1]);
  const afterReplay = fixture.graph.getCommittedMutationReceiptByOperation(artifact.operationId);
  assert.deepEqual({ operationId: afterReplay.operationId, receiptId: afterReplay.receiptId,
    receiptHash: afterReplay.receiptHash }, { operationId: beforeReplay.operationId,
    receiptId: beforeReplay.receiptId, receiptHash: beforeReplay.receiptHash });

  const mutations = [
    (value) => { value.receipt.canonicalPayload.actor = 'connector:other'; },
    (value) => { value.authority.identityKind = 'agent'; },
    (value) => { value.receipt.canonicalPayload.workspaceId = 'workspace-other'; },
    (value) => { value.authority.packageId = 'pkg.other'; },
    (value) => { value.authority.packageHash = '0'.repeat(64); },
    (value) => { value.receipt.operationId = 'operation-other'; },
    (value) => { value.receipt.canonicalPayload.memoryDraftId = 'candidate-other'; },
    (value) => { value.receipt.receiptId = 'receipt-other'; },
    (value) => { value.receipt.canonicalPayload.decision = 'allow'; },
    (value) => { value.receipt.canonicalPayload.verdict = 'allow'; },
    (value) => { value.receipt.canonicalPayload.status = 'complete'; },
    (value) => { value.receipt.receiptHash = '0'.repeat(64); },
  ];
  const baseline = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  for (const [index, mutate] of mutations.entries()) {
    const changed = structuredClone(baseline); mutate(changed);
    const changedFile = write(fixture.directory, `receipt-mutant-${index}.json`, changed);
    const rejected = await run(verifyArgs(fixture, changedFile, output, packageFile));
    assert.notEqual(rejected.status, 0, `mutant ${index} was accepted`);
    assert.equal(rejected.stderr, 'receipt artifact verification failed\n');
  }
  const rehashedMutations = [
    (value) => { value.receipt.canonicalPayload.actor = 'connector:other'; },
    (value) => { value.receipt.canonicalPayload.workspaceId = 'workspace-other'; },
    (value) => { value.receipt.canonicalPayload.admissionId = 'operation-other'; },
    (value) => { value.receipt.canonicalPayload.memoryDraftId = 'candidate-other'; },
    (value) => { value.receipt.canonicalPayload.decision = 'allow'; },
    (value) => { value.receipt.canonicalPayload.verdict = 'allow'; },
    (value) => { value.receipt.canonicalPayload.status = 'complete'; },
  ];
  for (const [index, mutate] of rehashedMutations.entries()) {
    const changed = structuredClone(baseline); mutate(changed); rehash(changed.receipt);
    const changedFile = write(fixture.directory, `receipt-rehashed-mutant-${index}.json`, changed);
    const rejected = await run(verifyArgs(fixture, changedFile, output, packageFile));
    assert.notEqual(rejected.status, 0, `rehashed mutant ${index} was accepted`);
    assert.equal(rejected.stderr, 'receipt artifact verification failed\n');
  }
});

test('signature, key, package hash, workspace and identity failures are mutation-free', async (t) => {
  const cases = [
    (fixture) => { const envelope = fixture.envelope(); envelope.signature.value = `${envelope.signature.value.slice(0, -2)}AA`; return envelope; },
    (fixture) => { const pkg = fixture.packageValue({ manifest: { workspaceId: 'workspace-other' } }); return fixture.envelope(pkg); },
    (fixture) => { const pkg = fixture.packageValue({ manifest: { createdBy: 'connector:other' } }); return fixture.envelope(pkg); },
    (fixture) => { const pkg = fixture.packageValue(); return fixture.envelope(pkg, fixture.sign(pkg, fixture.keys.privateKey, 'unknown-key')); },
    (fixture) => { const pkg = fixture.packageValue(); pkg.objects.candidateClaims[0].claim = 'changed after signing';
      return { package: pkg, signature: fixture.sign(fixture.packageValue(), fixture.keys.privateKey) }; },
  ];
  for (const [index, makeEnvelope] of cases.entries()) {
    const fixture = createRouteFixture(t);
    const harness = await createRouteHarness({ adapter: fixture.adapter });
    const input = write(fixture.directory, `rejected-${index}.json`, makeEnvelope(fixture));
    const output = path.join(fixture.directory, `rejected-${index}-response.json`);
    const result = await run(['admit', '--url', `http://127.0.0.1:${harness.port}/api/external-client/packages/admit`,
      '--api-key', harness.apiKey, '--input', input, '--output', output]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /^HTTP 403: request rejected\n$/);
    assert.equal(fs.existsSync(output), false);
    assert.deepEqual(counts(fixture), [0, 0, 0]);
    await harness.close();
  }
});

test('standalone client has zero repository-internal imports', () => {
  const source = fs.readFileSync(CLIENT, 'utf8');
  assert.equal(/require\(['"]\.\.?[\\/]/.test(source), false);
});
