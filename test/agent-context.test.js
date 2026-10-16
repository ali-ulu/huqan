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

// The tests below that run against the live repository assert the capsule's
// shape, its rule text and its ancestry reporting -- none of which depend on
// how long ago someone fetched. Left measured, they inherit the thirty minute
// baseline window and the suite's colour starts tracking the wall clock: green
// right after a fetch, five failures half an hour later, on an unchanged tree.
// That is what made `npm test` unreliable enough to be waived by name in a
// dozen closeout documents (#1291). Switching the measurement off at these
// call sites is the honest reading -- these tests never measured freshness --
// and it is switched off explicitly, not silently: the window itself is still
// covered, hermetically, by the `assessBaselineFreshness` cases below.
const MEASUREMENT_OFF = { maxAgeMs: 0 };

// The capsule's stable prefix, rule text and ordering are properties of the
// canon and protocol files, not of this clone's git history. Supplying the live
// section as a fixture keeps those assertions true on any checkout depth,
// including the `fetch-depth: 1` Coverage job that cannot resolve the
// checkpoint commit (#3368). The live section itself is covered below.
const DETERMINISTIC_GIT_STATE = {
  repository: 'ali-ulu/huqan',
  baselineBranch: 'main',
  currentBranch: 'feature/deterministic',
  head: '1111111111111111111111111111111111111111',
  originMain: '2222222222222222222222222222222222222222',
  checkpointMain: '3333333333333333333333333333333333333333',
  checkpointDrift: 'STALE_ANCESTOR',
  headPosition: 'AHEAD_OF_BASELINE',
  releaseTag: null,
  baselineFreshness: 'UNMEASURED_BY_CONFIG',
  baselineSyncedAt: null,
  worktree: 'CLEAN',
};

// A commit that is present in this clone but not reachable from origin/main, so
// the fail-closed ancestry test names a real conflict without depending on how
// much history the checkout holds (#3368). `origin/main^` would be an ancestor
// of origin/main and is therefore accepted as STALE_ANCESTOR, so the fixture is
// an independent root commit built from the empty tree -- present to
// `git cat-file`, yet an ancestor of nothing, on shallow and deep checkouts
// alike. It touches no ref and no worktree.
function presentNonAncestorCommit() {
  const cp = require('node:child_process');
  const tree = cp.execFileSync(
    'git',
    ['hash-object', '-t', 'tree', '-w', '--stdin'],
    { encoding: 'utf8', input: '' },
  ).trim();
  return cp.execFileSync(
    'git',
    ['commit-tree', tree, '-m', 'huqan agent-context test fixture'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'huqan test',
        GIT_AUTHOR_EMAIL: 'test@example.invalid',
        GIT_COMMITTER_NAME: 'huqan test',
        GIT_COMMITTER_EMAIL: 'test@example.invalid',
      },
    },
  ).trim();
}

// `origin/main` is a remote-tracking ref, so it exists only where the checkout
// fetched the branch. The Coverage job checks out with `fetch-depth: 1`, whose
// single-branch fetch leaves the ref absent, and the live assertions below then
// have no baseline to inspect -- `inspectGitState` fails closed on the missing
// evidence, which is correct for the guard but not a defect in the tree (#3368).
// Skip on that plumbing fact; the ancestry and freshness verdicts are covered
// hermetically in test/agent-context-git.test.js.
function hasOriginMain() {
  try {
    require('node:child_process').execFileSync(
      'git',
      ['rev-parse', '--verify', '--quiet', 'origin/main'],
      { stdio: 'ignore' },
    );
    return true;
  } catch {
    return false;
  }
}

test('agent context capsule is deterministic and ordered stable-first', () => {
  const first = buildContextCapsule({ gitState: DETERMINISTIC_GIT_STATE });
  const second = buildContextCapsule({ gitState: DETERMINISTIC_GIT_STATE });

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
  const capsule = buildContextCapsule({ gitState: DETERMINISTIC_GIT_STATE });

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

test('live Git validation accepts the canonical clone and reports worktree state', (t) => {
  if (!hasOriginMain()) {
    t.skip('this clone has no origin/main remote-tracking ref (shallow single-branch checkout)');
    return;
  }
  const checkpoint = require('../docs/current-agent-checkpoint.json');
  const originMain = require('node:child_process').execFileSync(
    'git',
    ['rev-parse', 'origin/main'],
    { encoding: 'utf8' },
  ).trim();
  const gitState = inspectGitState(checkpoint, MEASUREMENT_OFF);

  assert.equal(gitState.repository, checkpoint.repository);
  assert.equal(gitState.originMain, originMain);
  assert.equal(gitState.checkpointMain, checkpoint.canonicalMain);
  assert.ok(
    ['CURRENT', 'STALE_ANCESTOR', 'UNVERIFIED_IN_SHALLOW_CLONE'].includes(gitState.checkpointDrift),
    `unexpected checkpointDrift: ${gitState.checkpointDrift}`,
  );
  if (originMain === checkpoint.canonicalMain) {
    assert.equal(gitState.checkpointDrift, 'CURRENT');
  }
  assert.match(gitState.worktree, /^(CLEAN|DIRTY_REPORTED)$/);
});

test('live Git validation reports an older checkpoint ancestor without self-blocking', (t) => {
  const checkpoint = require('../docs/current-agent-checkpoint.json');
  let parent;
  try {
    parent = require('node:child_process').execFileSync(
      'git',
      ['rev-parse', 'origin/main^'],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    // A shallow checkout (`fetch-depth: 1`) holds only the tip of origin/main,
    // so there is no parent commit to point the checkpoint at. That is a
    // clone-plumbing fact, not a validation defect: the STALE_ANCESTOR verdict
    // itself is covered hermetically in test/agent-context-git.test.js (#3368).
    t.skip('this clone has no parent of origin/main (shallow checkout)');
    return;
  }
  const gitState = inspectGitState({
    ...checkpoint,
    canonicalMain: parent,
  }, MEASUREMENT_OFF);

  assert.equal(gitState.checkpointMain, parent);
  assert.equal(gitState.checkpointDrift, 'STALE_ANCESTOR');
});

test('live Git validation fails closed when checkpoint main is not in canonical ancestry', (t) => {
  if (!hasOriginMain()) {
    t.skip('this clone has no origin/main remote-tracking ref (shallow single-branch checkout)');
    return;
  }
  const checkpoint = {
    ...require('../docs/current-agent-checkpoint.json'),
    canonicalMain: presentNonAncestorCommit(),
  };
  const originMain = require('node:child_process').execFileSync(
    'git',
    ['rev-parse', 'origin/main'],
    { encoding: 'utf8' },
  ).trim();

  assert.throws(
    // The commit is present in the clone, yet it is not reachable from
    // origin/main: that is a real conflict, and the guard keeps it one
    // regardless of how deep the checkout is (#3368).
    () => inspectGitState(checkpoint, MEASUREMENT_OFF),
    (error) => error.code === 'CONTEXT_CONFLICT'
      // Conflicts are joined into one message, so a substring match alone would
      // also be satisfied by a stale-baseline conflict this test is not about:
      // on an unfetched clone it would pass while the ancestry check it names
      // never ran. Measurement off, the ancestry reason is the only one left.
      && error.message === `CONTEXT_CONFLICT: checkpoint main ${checkpoint.canonicalMain} `
        + `is not an ancestor of origin/main ${originMain}`,
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

// --- A release tag is behind the baseline on purpose, not by accident ---
//
// The guard knew two shapes: sitting on the baseline branch, or working on a
// branch that already contains it. A release checkout is neither. `publish.yml`
// checks out an immutable `v<version>` tag and proves, in its own authority
// step, that the tagged commit is an ancestor of the default branch -- so by
// the time the suite runs, HEAD is deliberately *behind* origin/main, by
// however many commits landed since the release. The guard read that as a
// feature branch that had failed to rebase and failed closed, which turned
// every publish run red at the one step that is supposed to certify the
// release. The tag is what distinguishes the two: an unrebased branch does not
// have one, and a tag alone is not enough either -- a tag pushed onto an
// arbitrary commit is exactly the thing `publish.yml` refuses, so the commit
// must still be reachable from origin/main.

const RELEASE_CHECKPOINT = {
  repository: 'ali-ulu/huqan',
  baselineBranch: 'main',
  canonicalMain: 'base',
};

// Ancestry as a release checkout actually observes it: the checkpoint and the
// tagged commit are both reachable from origin/main, and origin/main is
// reachable from neither.
const releaseAncestry = (ancestor, descendant) => descendant === 'remote-tip'
  && (ancestor === 'base' || ancestor === 'tagged-commit');

test('a release tag reachable from origin/main validates instead of failing closed', () => {
  const gitState = validateGitState(
    RELEASE_CHECKPOINT,
    {
      repository: 'ali-ulu/huqan',
      branch: '',
      head: 'tagged-commit',
      originMain: 'remote-tip',
      releaseTag: 'v0.11.0',
      worktree: '',
      ...FRESH_BASELINE,
    },
    releaseAncestry,
  );

  assert.equal(gitState.headPosition, 'RELEASE_TAG');
  assert.equal(gitState.releaseTag, 'v0.11.0');
  assert.equal(gitState.currentBranch, '(detached)');
});

test('a detached HEAD behind origin/main without a release tag still fails closed', () => {
  assert.throws(
    () => validateGitState(
      RELEASE_CHECKPOINT,
      {
        repository: 'ali-ulu/huqan',
        branch: '',
        head: 'tagged-commit',
        originMain: 'remote-tip',
        releaseTag: '',
        worktree: '',
        ...FRESH_BASELINE,
      },
      releaseAncestry,
    ),
    /\(detached\) does not descend from origin\/main/,
  );
});

test('a release tag outside canonical ancestry still fails closed', () => {
  assert.throws(
    () => validateGitState(
      RELEASE_CHECKPOINT,
      {
        repository: 'ali-ulu/huqan',
        branch: '',
        head: 'tag-on-an-arbitrary-commit',
        originMain: 'remote-tip',
        releaseTag: 'v9.9.9',
        worktree: '',
        ...FRESH_BASELINE,
      },
      releaseAncestry,
    ),
    /\(detached\) does not descend from origin\/main/,
  );
});

test('the release exemption does not cover a named branch that carries a tag', () => {
  assert.throws(
    () => validateGitState(
      RELEASE_CHECKPOINT,
      {
        repository: 'ali-ulu/huqan',
        branch: 'feature/stale',
        head: 'tagged-commit',
        originMain: 'remote-tip',
        releaseTag: 'v0.11.0',
        worktree: '',
        ...FRESH_BASELINE,
      },
      releaseAncestry,
    ),
    /feature branch feature\/stale does not descend from origin\/main/,
  );
});

test('the ordinary head positions are reported by name', () => {
  const evidence = {
    repository: 'ali-ulu/huqan',
    originMain: 'remote-tip',
    worktree: '',
    ...FRESH_BASELINE,
  };

  assert.equal(
    validateGitState(
      RELEASE_CHECKPOINT,
      { ...evidence, branch: 'main', head: 'remote-tip' },
      alwaysAncestor,
    ).headPosition,
    'BASELINE',
  );
  assert.equal(
    validateGitState(
      RELEASE_CHECKPOINT,
      { ...evidence, branch: 'feature/work', head: 'feature-tip' },
      alwaysAncestor,
    ).headPosition,
    'AHEAD_OF_BASELINE',
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

test('the live capsule reports a baseline freshness verdict (#682)', (t) => {
  if (!hasOriginMain()) {
    t.skip('this clone has no origin/main remote-tracking ref (shallow single-branch checkout)');
    return;
  }
  // Accepting any of the four verdicts made this assertion true no matter what
  // the clock said -- but reaching it required surviving `validateGitState`,
  // which throws on STALE and UNKNOWN, so the test failed on an unfetched clone
  // before it could assert anything (#1291). Pinning `now` one minute after the
  // baseline this clone actually recorded keeps it live -- the real ref, the
  // real evidence -- while asking for the one verdict that is then correct.
  const syncedAt = readBaselineSyncedAt();
  if (typeof syncedAt !== 'number') {
    // A plain clone (or one whose refs are already packed) leaves no fetch
    // trace in any file `baselineSyncPaths` looks at, so there is nothing
    // live to assert here (#3015). That is a clone-plumbing fact, not a
    // capsule defect: `assessBaselineFreshness draws the line exactly at the
    // threshold` above already covers the verdict logic hermetically.
    t.skip('this clone recorded no fetch trace (FETCH_HEAD / origin/main)');
    return;
  }

  const capsule = buildContextCapsule({
    gitStateOptions: { now: syncedAt + 60000, maxAgeMs: HALF_HOUR_MS },
  });

  assert.match(capsule, /"baselineFreshness": "FRESH"/);
  assert.match(capsule, new RegExp(`"baselineSyncedAt": "${new Date(syncedAt).toISOString()}"`));
});

// --- Hermetic wiring of the live collectors (#3368) -----------------------
//
// The live tests above skip whenever the checkout has no `origin/main` (the
// Coverage job's `fetch-depth: 1`), which left the `inspectGitState` wiring --
// every evidence call, the ancestry/hasCommit/isShallow probes and the baseline
// path resolution -- unexecuted under the ratchet. Injecting the git runner
// covers the same code on any checkout depth, without touching a ref.

const GIT_EVIDENCE = {
  repository: 'git@github.com:ali-ulu/huqan.git',
  branch: 'feature/hermetic',
  head: 'feature-tip',
  originMain: 'remote-tip',
  tag: '',
  status: '',
  gitDir: '/tmp/huqan-git-dir',
  shallow: 'false',
};

function fakeGit(overrides = {}) {
  const answers = { ...GIT_EVIDENCE, ...overrides };
  const seen = [];
  const runner = (args) => {
    const key = args.join(' ');
    seen.push(key);
    switch (key) {
      case 'config --get remote.origin.url': return answers.repository;
      case 'branch --show-current': return answers.branch;
      case 'rev-parse HEAD': return answers.head;
      case 'rev-parse origin/main': return answers.originMain;
      case 'tag --points-at HEAD': return answers.tag;
      case 'status --short': return answers.status;
      case 'rev-parse --git-dir': return answers.gitDir;
      case 'rev-parse --git-common-dir': return answers.gitDir;
      case 'rev-parse --is-shallow-repository': return answers.shallow;
      case `rev-parse --verify --quiet ${answers.checkpoint}^{commit}`:
        if (answers.present) return answers.checkpoint;
        throw new Error('missing object');
      default:
        if (key.startsWith('merge-base --is-ancestor ')) {
          const [, , ancestor, descendant] = key.split(' ');
          if (answers.ancestorPairs && answers.ancestorPairs.has(`${ancestor}>${descendant}`)) return '';
          throw new Error('not an ancestor');
        }
        throw new Error(`unexpected git call: ${key}`);
    }
  };
  return { runner, seen };
}

const HERMETIC_CHECKPOINT = {
  repository: 'ali-ulu/huqan',
  baselineBranch: 'main',
  canonicalMain: 'checkpoint',
};

test('inspectGitState reads its evidence through the injected runner, not the live clone (#3368)', () => {
  const { runner, seen } = fakeGit({
    originMain: 'checkpoint',
    ancestorPairs: new Set(['checkpoint>checkpoint', 'checkpoint>feature-tip']),
  });

  const gitState = inspectGitState(HERMETIC_CHECKPOINT, { maxAgeMs: 0 }, runner);

  assert.equal(gitState.repository, 'ali-ulu/huqan');
  assert.equal(gitState.currentBranch, 'feature/hermetic');
  assert.equal(gitState.head, 'feature-tip');
  assert.equal(gitState.originMain, 'checkpoint');
  assert.equal(gitState.checkpointDrift, 'CURRENT');
  assert.equal(gitState.headPosition, 'AHEAD_OF_BASELINE');
  assert.equal(gitState.baselineFreshness, 'UNMEASURED_BY_CONFIG');
  assert.equal(seen.includes('rev-parse --is-shallow-repository'), false, 'ancestry answered, no shallowness probe');
});

test('inspectGitState reports an absent checkpoint commit as unverified only in a shallow clone (#3368)', () => {
  const shallow = fakeGit({
    ancestorPairs: new Set(['remote-tip>feature-tip']),
    checkpoint: 'checkpoint',
    present: false,
    shallow: 'true',
  }).runner;
  const complete = fakeGit({
    ancestorPairs: new Set(['remote-tip>feature-tip']),
    checkpoint: 'checkpoint',
    present: false,
    shallow: 'false',
  }).runner;

  assert.equal(
    inspectGitState(HERMETIC_CHECKPOINT, { maxAgeMs: 0 }, shallow).checkpointDrift,
    'UNVERIFIED_IN_SHALLOW_CLONE',
  );
  assert.throws(
    () => inspectGitState(HERMETIC_CHECKPOINT, { maxAgeMs: 0 }, complete),
    /checkpoint main checkpoint is not present in this clone/,
  );
});

test('inspectGitState keeps a present-but-unrelated checkpoint commit a conflict (#3368)', () => {
  const { runner } = fakeGit({
    ancestorPairs: new Set(['remote-tip>feature-tip']),
    checkpoint: 'checkpoint',
    present: true,
    shallow: 'true',
  });

  assert.throws(
    () => inspectGitState(HERMETIC_CHECKPOINT, { maxAgeMs: 0 }, runner),
    /checkpoint main checkpoint is not an ancestor of origin\/main remote-tip/,
  );
});

test('buildContextCapsule wires the injected runner into the live git section (#3368)', () => {
  const { runner } = fakeGit({
    originMain: 'checkpoint',
    ancestorPairs: new Set(['checkpoint>checkpoint', 'checkpoint>feature-tip']),
  });

  const capsule = buildContextCapsule({
    checkpoint: HERMETIC_CHECKPOINT,
    gitStateOptions: { maxAgeMs: 0 },
    gitRunner: runner,
  });

  assert.match(capsule, /"originMain": "checkpoint"/);
  assert.match(capsule, /"checkpointDrift": "CURRENT"/);
  assert.match(capsule, /"headPosition": "AHEAD_OF_BASELINE"/);
});

test('baselineSyncPaths falls back to the one git dir it can resolve (#3368)', () => {
  const path = require('node:path');
  const { baselineSyncPaths } = require('../scripts/agent-context-baseline');

  const paths = baselineSyncPaths((args) => {
    if (args.join(' ') === 'rev-parse --git-dir') return '.git';
    throw new Error('no common dir');
  });

  assert.ok(paths.some((candidate) => candidate.endsWith(path.join('.git', 'FETCH_HEAD'))));
  assert.ok(paths.some((candidate) => candidate.endsWith(path.join('.git', 'refs', 'remotes', 'origin', 'main'))));
});

