'use strict';

/**
 * readRepoState ancestor-repo guard (#2992).
 *
 * git walks up from the queried directory, so a bare directory sitting under
 * a repository used to report the ancestor's branch and dirtiness as its own.
 * The state is trusted only when the repository root is the directory asked
 * about; otherwise `known: false` (nobody checked, not a clean tree).
 *
 * #3085: on Windows the two paths reach the comparison in different string
 * forms — git for Windows can answer `rev-parse --show-toplevel` with an 8.3
 * short name (`RUNNER~1`) while the caller asked about the long one. Node's
 * JavaScript `realpathSync` does not resolve short names, so both paths were
 * canonicalized to different strings and a real repository reported
 * `known: false`. `sameDirectory` now canonicalizes with
 * `fs.realpathSync.native`, which does.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const childProcess = require('node:child_process');

const { readRepoState } = require('../lib/cli-coder');

function makeRoot() {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-repostate-')));
}

function makeGitRoot(branch) {
  const root = makeRoot();
  const git = (args) => childProcess.execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  git(['init', '-b', branch, '-q']);
  git(['config', 'user.email', 'test@huqan.local']);
  git(['config', 'user.name', 'huqan-test']);
  fs.writeFileSync(path.join(root, 'seed.txt'), 'seed\n', 'utf8');
  git(['add', '-A']);
  git(['commit', '-qm', 'fixture']);
  return root;
}

describe('readRepoState', () => {
  it('reports a real repository root with its own branch', () => {
    const root = makeGitRoot('feat/repostate-probe');
    const state = readRepoState(root);
    assert.equal(state.known, true);
    assert.equal(state.branch, 'feat/repostate-probe');
    assert.equal(state.dirty, false);
    assert.equal(state.hasUntracked, false);
  });

  it('a bare directory reports unknown even under an ancestor repo', () => {
    const bare = makeRoot();
    fs.writeFileSync(path.join(bare, 'note.txt'), 'not a repo\n', 'utf8');
    const state = readRepoState(bare);
    // Either git fails (no ancestor repo on this machine) or the toplevel
    // mismatch fires (an ancestor repo exists): both are `known: false`.
    // What must never happen is reporting the ancestor's branch as ours.
    assert.equal(state.known, false);
    assert.equal(state.branch, '');
  });

  it('a dirty repository reports dirty, not clean', () => {
    const root = makeGitRoot('feat/repostate-dirty');
    fs.writeFileSync(path.join(root, 'seed.txt'), 'changed\n', 'utf8');
    const state = readRepoState(root);
    assert.equal(state.known, true);
    assert.equal(state.dirty, true);
  });

  it('a repository reached through a different path string is still recognised', () => {
    // #3085, portably. git and the caller can name the same directory with
    // different strings — an 8.3 short name on Windows, a symlinked ancestor
    // here. Canonicalizing only one side (or with the JS realpath, which does
    // not resolve short names) made a real repository report `known: false`.
    // Asking through a link to the root exercises the same canonicalization.
    const root = makeGitRoot('feat/repostate-linked');
    let viaLink;
    try {
      viaLink = path.join(makeRoot(), 'link-to-repo');
      fs.symlinkSync(root, viaLink, 'dir');
    } catch {
      // Directory symlinks need elevation on Windows CI; the fix is still
      // exercised by the plain cases above, so skip only the linked one.
      return;
    }
    const state = readRepoState(viaLink);
    assert.equal(state.known, true);
    assert.equal(state.branch, 'feat/repostate-linked');
  });
});
