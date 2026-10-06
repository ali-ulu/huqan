'use strict';

// `huqan-gate identity issue` (#2505). Before it, the only card issuance path
// was hand-written JSON in a test, so a fresh install blocked every call with
// `agent_identity_card_required` and no documented next step. These tests hold
// the two things that matter: the card it writes is one the guard accepts, and
// it refuses to overwrite anything it did not create.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { buildIdentityCard, DEFAULT_LIFETIME_MS } = require('../lib/external-action-identity-issue');
const { normalizeAgentIdentityCard } = require('../lib/external-action-identity-card');

const root = path.resolve(__dirname, '..');
const hook = path.join(root, 'bin', 'huqan-gate-hook.js');

function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-identity-issue-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function issue(directory, args) {
  return spawnSync(process.execPath, [hook, 'identity', 'issue', ...args], { cwd: root, encoding: 'utf8' });
}

test('a minted card normalizes cleanly through the guard vocabulary', () => {
  const now = new Date('2026-01-01T00:00:00.000Z');
  const { card, errors } = buildIdentityCard({
    agentId: 'openhands', ownerActorId: 'actor:ali', capabilities: ['shell'],
  }, now);
  assert.deepEqual(errors, []);
  assert.equal(card.agentName, 'openhands');
  assert.equal(card.onBehalfOf, 'actor:ali');
  assert.deepEqual(card.delegationChain, ['openhands']);
  assert.equal(Date.parse(card.expiresAt) - Date.parse(card.issuedAt), DEFAULT_LIFETIME_MS);
});

test('the CLI writes the card and reports its identity reference', t => {
  const directory = sandbox(t);
  const out = path.join(directory, 'card.json');
  const result = issue(directory, [
    '--agent-id', 'openhands', '--owner', 'actor:ali', '--capabilities', 'shell,file_read', '--out', out,
  ]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.ok, true);
  assert.equal(report.identityRef, 'agent:default:openhands');
  assert.deepEqual(JSON.parse(fs.readFileSync(out, 'utf8')).capabilities, ['shell', 'file_read']);
});

test('an unknown capability is refused and nothing is written', t => {
  const directory = sandbox(t);
  const out = path.join(directory, 'card.json');
  const result = issue(directory, ['--agent-id', 'a', '--owner', 'actor:ali', '--capabilities', 'teleport', '--out', out]);
  assert.equal(result.status, 1);
  assert.match(JSON.parse(result.stdout).errors.join(','), /capability_unknown/);
  assert.equal(fs.existsSync(out), false);
});

test('a lifetime over the schema cap is refused', () => {
  const { card, errors } = buildIdentityCard({
    agentId: 'a', ownerActorId: 'actor:ali', capabilities: ['shell'], lifetimeMs: 25 * 60 * 60 * 1000,
  }, new Date('2026-01-01T00:00:00.000Z'));
  assert.equal(card, null);
  assert.ok(errors.includes('lifetime_exceeds_24h'));
});

test('a minted signed card is accepted by the guard end to end', t => {
  const directory = sandbox(t);
  const keys = path.join(directory, 'keys');
  assert.equal(issue(directory, ['--generate-keypair', keys]).status, 0);
  const cardPath = path.join(directory, 'card.json');
  const signed = issue(directory, [
    '--agent-id', 'openhands', '--owner', 'actor:ali', '--capabilities', 'shell',
    '--out', cardPath, '--sign-key', path.join(keys, 'identity-card-private.pem'),
  ]);
  assert.equal(signed.status, 0, signed.stderr);
  const signaturePath = JSON.parse(signed.stdout).signaturePath;
  assert.ok(fs.existsSync(signaturePath));

  const payload = {
    event_type: 'PreToolUse', tool_name: 'terminal', tool_input: { command: 'git status' },
    session_id: 'identity-issue-e2e', working_dir: root,
  };
  const run = spawnSync(process.execPath, [
    hook, '--profile', 'openhands', '--workspace-root', root,
    '--receipt-log', path.join(directory, 'receipts.jsonl'),
    '--identity-card', cardPath,
    '--identity-card-signature', signaturePath,
    '--trusted-identity-keys', path.join(keys, 'identity-card-public.pem'),
  ], { cwd: root, input: JSON.stringify(payload), encoding: 'utf8' });
  assert.equal(run.stdout.trim(), '{}', `expected allow, got ${run.stdout}`);
});

test('issuing over an existing card fails rather than overwriting it', t => {
  const directory = sandbox(t);
  const out = path.join(directory, 'card.json');
  fs.writeFileSync(out, 'operator-owned');
  const result = issue(directory, ['--agent-id', 'openhands', '--owner', 'actor:ali', '--capabilities', 'shell', '--out', out]);
  assert.equal(result.status, 1);
  assert.equal(fs.readFileSync(out, 'utf8'), 'operator-owned');
});

test('the capability-card example in docs/external-action-guard.md is valid', () => {
  const doc = fs.readFileSync(path.join(root, 'docs', 'external-action-guard.md'), 'utf8');
  const blocks = [...doc.matchAll(/```json\n([\s\S]*?)```/g)].map(match => match[1]);
  const example = blocks.map(block => JSON.parse(block))
    .find(parsed => parsed.schemaVersion === 'huqan.agent-identity-card.v1');
  assert.ok(example, 'the guard doc still shows a capability card example');
  const { card, errors } = normalizeAgentIdentityCard(example);
  assert.deepEqual(errors, []);
  assert.ok(card);
});
