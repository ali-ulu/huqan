'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  DEFAULT_BASELINE_MAX_AGE_MINUTES,
  assessBaselineFreshness,
  buildContextCapsule,
  formatContextCapsule,
  inspectGitState,
  readBaselineSyncedAt,
  resolveBaselineMaxAgeMs,
  validateGitState,
} = require('../scripts/agent-context');

// Synthetic evidence carries a baseline that was just synced, so the three
// ancestry tests below each fail for the one reason they name rather than
// collecting a stale-baseline conflict as well (#682).
const FRESH_BASELINE = { baselineSyncedAt: Date.now() };

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
    ...FRESH_BASELINE,
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
    ...FRESH_BASELINE,
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
    ...FRESH_BASELINE,
  };
  const isAncestor = (ancestor, descendant) => (
    ancestor === 'base' && descendant === 'remote-tip'
  );

  assert.throws(
    () => validateGitState(checkpoint, evidence, isAncestor),
    /feature branch feature\/stale does not descend from origin\/main/,
  );
});

// --- #682: the guard must measure how old the baseline it read actually is ---
//
// The ancestry check reads `origin/main`, a local ref that only moves when
// something fetches. Left unmeasured it goes stale over a long session and the
// check keeps passing against a `main` that CI has already moved past. This was
// reproduced on the same head: with the local ref rolled back three commits the
// suite reported 9/9, and with the ref refreshed it reported 4 failures.

const STALE_CHECKPOINT = {
  repository: 'ali-ulu/huqan',
  baselineBranch: 'main',
  canonicalMain: 'base',
};

function baselineEvidence(baselineSyncedAt) {
  return {
    repository: 'ali-ulu/huqan',
    branch: 'feature/work',
    head: 'feature-tip',
    originMain: 'remote-tip',
    worktree: '',
    baselineSyncedAt,
  };
}

const NOW = Date.parse('2026-08-14T12:00:00Z');
const HALF_HOUR_MS = 30 * 60000;
const alwaysAncestor = () => true;

test('a stale origin/main is a conflict, not a silent pass (#682)', () => {
  assert.throws(
    () => validateGitState(
      STALE_CHECKPOINT,
      baselineEvidence(NOW - (91 * 60000)),
      alwaysAncestor,
      { now: NOW, maxAgeMs: HALF_HOUR_MS },
    ),
    (error) => error.code === 'CONTEXT_CONFLICT'
      && /origin\/main was last synced with the remote 91 minutes ago, past the 30 minute limit/.test(error.message)
      && /git fetch --no-tags origin \+refs\/heads\/main:refs\/remotes\/origin\/main/.test(error.message),
  );
});

test('a recently synced origin/main still passes and reports its age verdict (#682)', () => {
  const gitState = validateGitState(
    STALE_CHECKPOINT,
    baselineEvidence(NOW - 60000),
    alwaysAncestor,
    { now: NOW, maxAgeMs: HALF_HOUR_MS },
  );

  assert.equal(gitState.baselineFreshness, 'FRESH');
  assert.equal(gitState.baselineSyncedAt, new Date(NOW - 60000).toISOString());
});

test('an unmeasurable origin/main fails closed rather than assuming it is current (#682)', () => {
  for (const missing of [undefined, null, Number.NaN]) {
    assert.throws(
      () => validateGitState(
        STALE_CHECKPOINT,
        baselineEvidence(missing),
        alwaysAncestor,
        { now: NOW, maxAgeMs: HALF_HOUR_MS },
      ),
      (error) => error.code === 'CONTEXT_CONFLICT'
        && /origin\/main has no recorded sync with the remote, so its age cannot be measured/.test(error.message),
    );
  }
});

test('an offline run may switch the measurement off, but never silently (#682)', () => {
  // The point of the escape hatch is that it leaves a mark. A run that did not
  // measure the baseline must not be readable as a run that measured it and
  // found it fine.
  const gitState = validateGitState(
    STALE_CHECKPOINT,
    baselineEvidence(NOW - (30 * 24 * 60 * 60000)),
    alwaysAncestor,
    { now: NOW, maxAgeMs: 0 },
  );

  assert.equal(gitState.baselineFreshness, 'UNMEASURED_BY_CONFIG');
  assert.equal(gitState.baselineSyncedAt, null);
  assert.notEqual(gitState.baselineFreshness, 'FRESH');
});

test('the staleness threshold is configurable and rejects nonsense (#682)', () => {
  assert.equal(resolveBaselineMaxAgeMs({}), DEFAULT_BASELINE_MAX_AGE_MINUTES * 60000);
  assert.equal(resolveBaselineMaxAgeMs({ HUQAN_BASELINE_MAX_AGE_MINUTES: '' }), DEFAULT_BASELINE_MAX_AGE_MINUTES * 60000);
  assert.equal(resolveBaselineMaxAgeMs({ HUQAN_BASELINE_MAX_AGE_MINUTES: '5' }), 5 * 60000);
  assert.equal(resolveBaselineMaxAgeMs({ HUQAN_BASELINE_MAX_AGE_MINUTES: '0' }), 0);

  for (const raw of ['-1', 'soon', 'NaN']) {
    assert.throws(
      () => resolveBaselineMaxAgeMs({ HUQAN_BASELINE_MAX_AGE_MINUTES: raw }),
      (error) => error.code === 'CONTEXT_CONFLICT'
        && /HUQAN_BASELINE_MAX_AGE_MINUTES must be a non-negative number of minutes/.test(error.message),
    );
  }
});

test('freshness is read from the files a fetch touches, newest wins (#682)', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-baseline-'));
  try {
    assert.equal(readBaselineSyncedAt([path.join(dir, 'FETCH_HEAD')]), null, 'nothing to read means nothing is claimed');

    const older = path.join(dir, 'FETCH_HEAD');
    const newer = path.join(dir, 'ref');
    fs.writeFileSync(older, '');
    fs.writeFileSync(newer, '');
    fs.utimesSync(older, new Date(NOW - 7200000), new Date(NOW - 7200000));
    fs.utimesSync(newer, new Date(NOW - 60000), new Date(NOW - 60000));

    assert.equal(readBaselineSyncedAt([older, newer]), NOW - 60000);
    assert.equal(readBaselineSyncedAt([newer, older]), NOW - 60000);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('assessBaselineFreshness draws the line exactly at the threshold (#682)', () => {
  const at = (ageMs) => assessBaselineFreshness(NOW - ageMs, { now: NOW, maxAgeMs: HALF_HOUR_MS }).verdict;

  assert.equal(at(0), 'FRESH');
  assert.equal(at(HALF_HOUR_MS), 'FRESH', 'exactly at the limit is still inside it');
  assert.equal(at(HALF_HOUR_MS + 1), 'STALE');
  // A clock that jumped backwards must not read as an ancient baseline.
  assert.equal(at(-60000), 'FRESH');
});

test('the live capsule reports a baseline freshness verdict (#682)', () => {
  const capsule = buildContextCapsule();

  assert.match(capsule, /"baselineFreshness": "(FRESH|STALE|UNKNOWN|UNMEASURED_BY_CONFIG)"/);
});
