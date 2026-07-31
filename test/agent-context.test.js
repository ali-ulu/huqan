'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildContextCapsule,
  formatContextCapsule,
  inspectGitState,
  validateGitState,
} = require('../scripts/agent-context');

test('agent context capsule is deterministic and ordered stable-first', () => {
  const first = buildContextCapsule();
  const second = buildContextCapsule();

  assert.equal(first, second);
  assert.match(first, /^# HUQAN Agent Context Capsule\n/);
  assert.match(first, /CANON_SHA256: [a-f0-9]{64}/);
  assert.match(first, /PROTOCOL_SHA256: [a-f0-9]{64}/);
  assert.match(first, /CHECKPOINT_SHA256: [a-f0-9]{64}/);
  assert.ok(first.indexOf('## Stable Canon') < first.indexOf('## Stable Delivery Protocol'));
  assert.ok(first.indexOf('## Stable Delivery Protocol') < first.indexOf('## Mutable Checkpoint'));
  assert.ok(first.indexOf('## Mutable Checkpoint') < first.indexOf('CHECKPOINT_SHA256'));
});

test('agent context capsule exposes the exact Ponytail, delivery, and Graphify rules', () => {
  const capsule = buildContextCapsule();

  assert.match(capsule, /Does this need to exist\? If no, skip it\./);
  assert.match(capsule, /Is it already in this codebase\? Reuse it; do not rewrite it\./);
  assert.match(capsule, /\[BAĞLAM\].*\[GÖREV\].*\[KABUL\]/s);
  assert.match(capsule, /\[YASAK\].*\[SÜRÜM\]/s);
  assert.match(capsule, /GÖZLENDİ.*TÜRETİLDİ.*VARSAYILDI/s);
  assert.match(capsule, /DOĞRULANMADI/);
  assert.match(capsule, /2 dakikalık göz testi/);
  assert.match(capsule, /7\/7 değilse teslim etme/);
  assert.match(capsule, /graphify-out\/GRAPH_REPORT\.md/);
  assert.match(capsule, /graphify-out\/wiki\/index\.md/);
  assert.match(capsule, /graphify update \./);
  assert.doesNotMatch(capsule, /UNRESOLVED_DEFINITION/);
  assert.doesNotMatch(capsule, /unresolvedExternalRules/);
});

test('mutable checkpoint changes do not alter the stable cache prefix', () => {
  const canon = '# Stable rule';
  const deliveryProtocol = '# Stable delivery rule';
  const gitState = { repository: 'ali-ulu/huqan', worktree: 'CLEAN' };
  const first = formatContextCapsule(
    canon,
    { canonicalMain: 'a' },
    gitState,
    deliveryProtocol,
  );
  const second = formatContextCapsule(
    canon,
    { canonicalMain: 'b' },
    gitState,
    deliveryProtocol,
  );
  const stableEnd = first.indexOf('## Mutable Checkpoint');

  assert.equal(first.slice(0, stableEnd), second.slice(0, stableEnd));
  assert.notEqual(first, second);
});

test('live Git validation accepts the canonical clone and reports worktree state', () => {
  const checkpoint = require('../docs/current-agent-checkpoint.json');
  const gitState = inspectGitState(checkpoint);
  const originMain = require('node:child_process').execFileSync(
    'git',
    ['rev-parse', 'origin/main'],
    { encoding: 'utf8' },
  ).trim();

  assert.equal(gitState.repository, checkpoint.repository);
  assert.equal(gitState.originMain, originMain);
  assert.equal(gitState.checkpointMain, checkpoint.canonicalMain);
  assert.equal(
    gitState.checkpointDrift,
    originMain === checkpoint.canonicalMain ? 'CURRENT' : 'STALE_ANCESTOR',
  );
  assert.match(gitState.worktree, /^(CLEAN|DIRTY_REPORTED)$/);
});

test('live Git validation reports an older checkpoint ancestor without self-blocking', () => {
  const checkpoint = require('../docs/current-agent-checkpoint.json');
  const parent = require('node:child_process').execFileSync(
    'git',
    ['rev-parse', 'origin/main^'],
    { encoding: 'utf8' },
  ).trim();
  const gitState = inspectGitState({
    ...checkpoint,
    canonicalMain: parent,
  });

  assert.equal(gitState.checkpointMain, parent);
  assert.equal(gitState.checkpointDrift, 'STALE_ANCESTOR');
});

test('live Git validation fails closed when checkpoint main is not in canonical ancestry', () => {
  const checkpoint = {
    ...require('../docs/current-agent-checkpoint.json'),
    canonicalMain: '0000000000000000000000000000000000000000',
  };

  assert.throws(
    () => inspectGitState(checkpoint),
    (error) => error.code === 'CONTEXT_CONFLICT'
      && /checkpoint main 0000000000000000000000000000000000000000 is not an ancestor/.test(
        error.message,
      ),
  );
});

test('Git validation fails closed on repository identity mismatch', () => {
  const checkpoint = {
    repository: 'ali-ulu/huqan',
    baselineBranch: 'main',
    canonicalMain: 'base',
  };
  const evidence = {
    repository: 'attacker/fork',
    branch: 'main',
    head: 'tip',
    originMain: 'tip',
    worktree: '',
  };

  assert.throws(
    () => validateGitState(checkpoint, evidence, () => true),
    /repository expected ali-ulu\/huqan, observed attacker\/fork/,
  );
});

test('Git validation fails closed when baseline HEAD trails origin/main', () => {
  const checkpoint = {
    repository: 'ali-ulu/huqan',
    baselineBranch: 'main',
    canonicalMain: 'base',
  };
  const evidence = {
    repository: 'ali-ulu/huqan',
    branch: 'main',
    head: 'stale-tip',
    originMain: 'remote-tip',
    worktree: '',
  };

  assert.throws(
    () => validateGitState(checkpoint, evidence, () => true),
    /baseline HEAD expected origin\/main remote-tip, observed stale-tip/,
  );
});

test('Git validation fails closed when a feature branch omits current origin/main', () => {
  const checkpoint = {
    repository: 'ali-ulu/huqan',
    baselineBranch: 'main',
    canonicalMain: 'base',
  };
  const evidence = {
    repository: 'ali-ulu/huqan',
    branch: 'feature/stale',
    head: 'feature-tip',
    originMain: 'remote-tip',
    worktree: '',
  };
  const isAncestor = (ancestor, descendant) => (
    ancestor === 'base' && descendant === 'remote-tip'
  );

  assert.throws(
    () => validateGitState(checkpoint, evidence, isAncestor),
    /feature branch feature\/stale does not descend from origin\/main/,
  );
});
