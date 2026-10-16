'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  ACTION_BINDING_SCHEMA_VERSION,
  actionBindingMatches,
  buildExternalActionBinding,
} = require('../lib/external-action-action-binding');

function envelope(overrides = {}) {
  return {
    kind: 'shell',
    tool: { name: 'Bash', kind: 'shell' },
    command: 'git branch -m feature',
    cwd: '/workspace/project/huqan',
    workspaceId: 'default',
    ...overrides,
  };
}

test('binds the action as a deterministic sha256 digest', () => {
  const binding = buildExternalActionBinding(envelope());
  assert.equal(binding.schemaVersion, ACTION_BINDING_SCHEMA_VERSION);
  assert.match(binding.digest, /^[a-f0-9]{64}$/);
});

test('the same action produces the same digest across calls and key order', () => {
  const first = buildExternalActionBinding(envelope());
  const second = buildExternalActionBinding(envelope());
  assert.equal(first.digest, second.digest);

  // Same values, built in a different insertion order: canonicalization has to
  // absorb this, otherwise two observers of one action disagree.
  const reordered = buildExternalActionBinding({
    workspaceId: 'default',
    cwd: '/workspace/project/huqan',
    command: 'git branch -m feature',
    tool: { kind: 'shell', name: 'Bash' },
    kind: 'shell',
  });
  assert.equal(reordered.digest, first.digest);
});

test('an environment change does not change the digest', () => {
  const base = buildExternalActionBinding(envelope());
  const withEnv = buildExternalActionBinding(envelope({
    env: { PATH: '/usr/bin', TZ: 'UTC', TOKEN: 'changed' },
  }));
  assert.equal(withEnv.digest, base.digest, 'env must stay outside the binding');
});

test('a cwd change changes the digest', () => {
  const base = buildExternalActionBinding(envelope());
  const elsewhere = buildExternalActionBinding(envelope({ cwd: '/workspace/other' }));
  assert.notEqual(elsewhere.digest, base.digest);
});

test('a workspace change changes the digest', () => {
  const base = buildExternalActionBinding(envelope());
  const otherWorkspace = buildExternalActionBinding(envelope({ workspaceId: 'tenant-b' }));
  assert.notEqual(otherWorkspace.digest, base.digest, 'an approval must not cross a workspace');
});

test('a command change changes the digest', () => {
  const base = buildExternalActionBinding(envelope());
  const other = buildExternalActionBinding(envelope({ command: 'git branch -D feature' }));
  assert.notEqual(other.digest, base.digest);
});

test('a tool name change changes the digest', () => {
  const base = buildExternalActionBinding(envelope());
  const other = buildExternalActionBinding(envelope({ tool: { name: 'shell', kind: 'shell' } }));
  assert.notEqual(other.digest, base.digest);
});

test('a missing workspaceId falls back to default rather than an empty component', () => {
  const withoutWorkspace = buildExternalActionBinding(envelope({ workspaceId: undefined }));
  const withDefault = buildExternalActionBinding(envelope({ workspaceId: 'default' }));
  assert.equal(withoutWorkspace.digest, withDefault.digest);
});

test('a non-shell action binds without inventing a command', () => {
  const binding = buildExternalActionBinding(envelope({
    kind: 'file_write',
    tool: { name: 'Write', kind: 'file_write' },
    command: '',
  }));
  assert.equal(binding.components.command, '');
  assert.match(binding.digest, /^[a-f0-9]{64}$/);
});

test('the binding is a narrowing claim beside inputDigest, not a replacement', () => {
  const binding = buildExternalActionBinding(envelope());
  assert.deepEqual(Object.keys(binding).sort(), ['components', 'digest', 'schemaVersion']);
  assert.deepEqual(Object.keys(binding.components).sort(), [
    'actionType', 'command', 'cwd', 'toolName', 'workspaceId',
  ]);
});

test('actionBindingMatches accepts the same action and refuses a changed one', () => {
  const binding = buildExternalActionBinding(envelope());
  assert.equal(actionBindingMatches(binding, envelope()), true);
  assert.equal(actionBindingMatches(binding, envelope({ command: 'rm -rf /' })), false);
  assert.equal(actionBindingMatches(binding, envelope({ cwd: '/elsewhere' })), false);
  assert.equal(actionBindingMatches(binding, envelope({ workspaceId: 'other' })), false);
});

test('actionBindingMatches refuses a missing or malformed binding', () => {
  assert.equal(actionBindingMatches(null, envelope()), false);
  assert.equal(actionBindingMatches(undefined, envelope()), false);
  assert.equal(actionBindingMatches({}, envelope()), false);
  assert.equal(actionBindingMatches({ digest: '' }, envelope()), false);
  assert.equal(actionBindingMatches('not-an-object', envelope()), false);
});

test('a binding cannot be replayed across a tampered digest', () => {
  const binding = buildExternalActionBinding(envelope());
  const tampered = { ...binding, digest: `${binding.digest.slice(0, -1)}0` };
  assert.equal(actionBindingMatches(tampered, envelope()), false);
});
