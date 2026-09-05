'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeAgentIdentityCard } = require('../lib/external-action-identity');
const { generateIdentityCardKeyPair, signAgentIdentityCard } = require('../lib/external-action-identity-signing');
const { evaluateExternalAction } = require('../lib/external-action-guard');
const { buildBackgroundProvenance, commitBackgroundEdge } = require('../lib/background-provenance');
const { publicKeyPem, privateKeyPem } = generateIdentityCardKeyPair();
const otherKeys = generateIdentityCardKeyPair();
const authority = () => ({ schemaVersion: 'huqan.human-sponsor-authority.v1', principals: [
  { actorId: 'human:alice', kind: 'human', status: 'active', workspaceIds: ['default'],
    capabilities: ['file_read', 'memory_mutation'], publicKeys: [publicKeyPem] },
], background: [{ source: 'dream', workspaceId: 'default', actorId: 'human:alice' }] });
function invocation(overrides = {}) {
  const { card } = normalizeAgentIdentityCard({ schemaVersion: 'huqan.agent-identity-card.v1',
    agentId: 'agent:test', agentName: 'test', ownerActorId: 'human:alice',
    workspaceId: 'default', capabilities: ['file_read'], issuedAt: '2026-01-01T00:00:00.000Z' });
  return { invocationId: 'sponsor-test', sessionId: 'session-test', turnId: 'turn-test', agentName: 'test', toolName: 'Read',
    args: { file_path: path.join(process.cwd(), 'README.md') }, cwd: process.cwd(),
    workspaceRoot: process.cwd(), workspaceId: 'default', identity: card,
    identityCardSignature: signAgentIdentityCard(card, privateKeyPem), ...overrides };
}
function evaluate(input = invocation(), config = authority(), options = {}) {
  return evaluateExternalAction(input, { environment: { NODE_ENV: 'production' },
    humanSponsorAuthority: config, ...options });
}
test('production admits a signed scoped human sponsor and records it on the receipt', () => {
  const result = evaluate();
  assert.equal(result.decision, 'allow', JSON.stringify(result.findings));
  assert.deepEqual(result.envelope.identity.humanSponsor, { actorId: 'human:alice', verified: true,
    workspaceId: 'default', capability: 'file_read' });
  assert.equal(result.receipt.metadata.identity.humanSponsor.actorId, 'human:alice');
});
test('production rejects absent cards despite false opt-in switches', () => {
  const result = evaluate(invocation({ identity: undefined }), authority(), {
    requireIdentityCard: false, requireSignedIdentityCard: false });
  assert.equal(result.decision, 'block');
});
test('production rejects missing, forged and wrong-human signatures', () => {
  const input = invocation();
  for (const signature of [undefined, { signature: 'fake' }, signAgentIdentityCard(input.identity, otherKeys.privateKeyPem)]) {
    assert.equal(evaluate({ ...input, identityCardSignature: signature }, authority(), {
      trustedPublicKeys: [otherKeys.publicKeyPem], requireSignedIdentityCard: false }).decision, 'block');
  }
});
test('production rejects unknown, revoked, nonhuman and out-of-scope principals', () => {
  for (const patch of [{ actorId: 'other' }, { status: 'revoked' }, { kind: 'agent' },
    { workspaceIds: ['other'] }, { capabilities: ['shell'] }, { publicKeys: [] }]) {
    const config = authority(); Object.assign(config.principals[0], patch);
    assert.equal(evaluate(invocation(), config).decision, 'block', JSON.stringify(patch));
  }
  for (const config of [null, {}, { ...authority(), principals: [...authority().principals, ...authority().principals] }]) {
    assert.equal(evaluate(invocation(), config).decision, 'block');
  }
});
test('signed onBehalfOf substitution cannot impersonate another sponsor', () => {
  const input = invocation(); input.identity = { ...input.identity, onBehalfOf: 'human:bob' };
  input.identityCardSignature = signAgentIdentityCard(input.identity, privateKeyPem);
  assert.equal(evaluate(input).decision, 'block');
});
function productionConfig(t, config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-sponsor-'));
  const target = path.join(dir, 'authority.json');
  fs.writeFileSync(target, JSON.stringify(config));
  const previous = { NODE_ENV: process.env.NODE_ENV, HUQAN_HUMAN_SPONSOR_AUTHORITY: process.env.HUQAN_HUMAN_SPONSOR_AUTHORITY };
  process.env.NODE_ENV = 'production'; process.env.HUQAN_HUMAN_SPONSOR_AUTHORITY = target;
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return target;
}
test('production hook evaluator loads receiver authority from the deployment file', t => {
  productionConfig(t, authority());
  assert.equal(evaluateExternalAction(invocation()).decision, 'allow');
  assert.equal(evaluateExternalAction(invocation({ identity: undefined, humanSponsorAuthority: authority() })).decision, 'block');
});
test('background provenance carries a verified sponsor and ignores a forged override', t => {
  productionConfig(t, authority());
  const p = buildBackgroundProvenance('dream', 'default', { humanSponsor: { actorId: 'evil' }, workspaceId: 'other' });
  assert.equal(p.humanSponsor.actorId, 'human:alice');
  assert.equal(p.humanSponsor.verified, true);
  assert.equal(p.workspaceId, 'default');
});
test('background unattended exception requires an exact deployment grant and a reason', t => {
  const config = authority(); config.background = [{ source: 'dream', workspaceId: 'default',
    mode: 'unattended', justification: 'Scheduled maintenance of local knowledge' }];
  productionConfig(t, config);
  assert.equal(buildBackgroundProvenance('dream').humanSponsor.justification, config.background[0].justification);
  assert.throws(() => buildBackgroundProvenance('plugin'), /background_human_sponsor_required/);
  assert.throws(() => buildBackgroundProvenance('dream', 'other'), /background_human_sponsor_required/);
});
test('missing authority blocks background mutation even with an admission bypass', t => {
  productionConfig(t, {});
  let writes = 0;
  const commit = commitBackgroundEdge({ evaluateLearnAdmission: () => null,
    appendAuditEvent: () => null, addEdge: () => { writes++; } });
  assert.throws(() => commit('a', 'b', 'related', 'dream', {
    admissionOpts: { admissionBypassReason: 'pretend approved' },
    provenanceExtra: { humanSponsor: { verified: true, actorId: 'human:alice' } },
  }), /background_human_sponsor_required/);
  assert.equal(writes, 0);
});
test('authority revocation and corrupt configuration are observed without restart', t => {
  const target = productionConfig(t, authority());
  assert.equal(evaluateExternalAction(invocation()).decision, 'allow');
  const revoked = authority(); revoked.principals[0].status = 'revoked';
  fs.writeFileSync(target, JSON.stringify(revoked));
  assert.equal(evaluateExternalAction(invocation()).decision, 'block');
  fs.writeFileSync(target, '{');
  assert.equal(evaluateExternalAction(invocation()).decision, 'block');
  assert.throws(() => buildBackgroundProvenance('dream'), /background_human_sponsor_required/);
});

test('real kernel plugin nodes and background edges preserve sponsorship', t => {
  const Kernel = require('../kernel');
  const { isolatedKernelOptions } = require('./helpers/isolated-persistence');
  const kernel = new Kernel(isolatedKernelOptions('human-sponsor', { loadPlugins: false }));
  for (const statement of ['kedi hayvandir', 'kopek hayvandir']) {
    assert.equal(kernel.learn(statement, Kernel.createAdmissionBypassOpts('test fixture seed')).ok, true);
  }
  const config = authority(); config.background.push({ source: 'plugin', workspaceId: 'default', actorId: 'human:alice' });
  productionConfig(t, config);
  const result = kernel._commitBackgroundEdge('kedi', 'kopek', 'benzer', 'dream', {
    admissionOpts: Kernel.createAdmissionBypassOpts('test sponsored background write'),
  });
  assert.equal(result.decision, 'allow');
  assert.equal(result.edge.provenance.humanSponsor.actorId, 'human:alice');
  const node = kernel.proposeNode('sponsor-node', 'Sponsored node', {
    provenanceId: 'sponsor-node-provenance', actor: 'plugin', sourceType: 'plugin',
    humanSponsor: { verified: true, actorId: 'forged' },
  });
  assert.equal(node.decision, 'allow');
  assert.equal(node.node.provenance.humanSponsor.actorId, 'human:alice');
});
test('real kernel rejects supplied plugin provenance without a configured grant', t => {
  const Kernel = require('../kernel');
  const { isolatedKernelOptions } = require('./helpers/isolated-persistence');
  const kernel = new Kernel(isolatedKernelOptions('human-sponsor-reject', { loadPlugins: false }));
  productionConfig(t, authority());
  assert.throws(() => kernel.proposeNode('forged-node', 'Forged', {
    actor: 'human:alice', humanSponsor: { verified: true, actorId: 'human:alice' },
  }), /background_human_sponsor_required/);
  assert.equal(kernel.graph.getNode('forged-node'), null);
});
test('CLI production hook admits signed sponsor and blocks unsigned input', t => {
  const { spawnSync } = require('node:child_process');
  const target = productionConfig(t, authority());
  const dir = path.dirname(target);
  const input = invocation();
  const cardPath = path.join(dir, 'card.json'); const signaturePath = path.join(dir, 'signature.json');
  fs.writeFileSync(cardPath, JSON.stringify(input.identity));
  fs.writeFileSync(signaturePath, JSON.stringify(input.identityCardSignature));
  const args = ['bin/huqan-gate-hook.js', '--profile', 'generic',
    '--receipt-log', path.join(dir, 'receipts.jsonl'), '--memory-path', path.join(dir, 'memory.json'),
    '--db-path', path.join(dir, 'memory.db'), '--identity-card', cardPath];
  const unsigned = { ...input }; delete unsigned.identity; delete unsigned.identityCardSignature;
  const run = (extra) => spawnSync(process.execPath, [...args, ...extra], {
    input: JSON.stringify(unsigned), encoding: 'utf8', timeout: 15000, env: process.env });
  const accepted = run(['--identity-card-signature', signaturePath]);
  assert.equal(accepted.status, 0, accepted.stderr + accepted.stdout);
  const rejected = run([]);
  assert.notEqual(rejected.status, 0, rejected.stdout);
  const receipts = fs.readFileSync(path.join(dir, 'receipts.jsonl'), 'utf8');
  assert.match(receipts, /human:alice/);
  assert.match(receipts, /humanSponsor/);
});
