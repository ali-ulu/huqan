'use strict';

/**
 * Heavy-test-file policy for the shard runner (#4416).
 *
 * The per-file deadline, the files allowed to exceed it, and the one file with
 * a scoped override lived inside scripts/run-test-shard.js until that file hit
 * its 400-line budget. They are a self-contained policy table, not runner
 * logic, so they move here unchanged; run-test-shard.js re-exports them so
 * every existing consumer keeps the same import.
 */

// Per-file deadline for a single test file inside a shard.
//
// 90s is 3-4x the historical max per-file wall time and is what makes a hang
// visible instead of waiting for the 20m job timeout (#1845, #1847).
const DEFAULT_FILE_TIMEOUT_MS = 90_000;

// Files that legitimately take longer than that because they install a package
// and run it, rather than because they hang.
//
// kernel-facade-contract runs a real `npm pack` + `npm install` of the tarball
// (internal subprocess timeouts alone allow 60s + 15s + 120s). On the Windows
// runner that crossed the 90s cap intermittently, killing a file that was still
// working and reddening CI on PRs that never touched it. The other three spawn
// a full external runner or a browser; they are slow by construction too.
// coder-project-method-memory restarts the native CLI and runs real HTTP
// heldouts in each of its ten cases (140s+ locally); on the Windows runner it
// crossed 90s on main (82c8ff8a) and on unrelated PRs (#3882).
//
// The cap stays 90s for everything else: this widens the deadline for exactly
// the paths that do install-scale work, and leaves the hang detection that
// #1847 added intact everywhere it was aimed.
const HEAVY_FILE_TIMEOUT_MS = 240_000;

// One heavy file needs more than the shared budget, because its own internal
// timeouts already sum past it.
//
// kernel-facade-contract runs a real `npm pack` + `npm install` of the tarball
// and then runs the installed binary. On Windows its install alone is allowed
// 180s per attempt and it retries once, so the path that still succeeds runs
// 60s (pack) + 15s (npm init) + 180s (the stalled first attempt) + the
// install that succeeds + 60s (the installed MCP binary over stdio) and the
// remaining consumers' own timeouts on top: about 535s in the worst case that
// still ends green.
//
// The shared 240s was computed from 60s + 15s + 120s -- the non-Windows
// numbers, without the retry. So a stalled install was killed mid-work and
// reddened CI on PRs that never touched the file, which is the same failure
// #1847 was about, one tier up. The override is scoped to that one file, so
// every other heavy file keeps the 240s hang detection.
const HEAVY_FILE_TIMEOUT_OVERRIDES = Object.freeze({
  'test/kernel-facade-contract.test.js': 540_000,
  // The G3 enlarged sealed-run cohort (#4449) is the heaviest non-install file:
  // 142 real `cli.js coder` child processes at the frozen N=70 protocol, ~112s
  // locally on Node 24. Windows process spawn is the same ~2x that turned the
  // 60s M5 file into a >90s kill above, so the 240s shared cap leaves too little
  // headroom for a file that cannot be shortened without dropping below the
  // margin-provable size (59).
  'test/g3-sealed-run-cohort-result.test.js': 360_000,
});
const HEAVY_FILES = Object.freeze(new Set([
  // Real per-case Git/approval/rollback checks passed in 221s under local load.
  'test/agent-coder-execution.test.js',
  // Native project approvals, HTTP acceptance and sealed-memory restarts exceeded 108s locally.
  'test/agent-coder-project-execution.test.js',
  // Approved project creation, HTTP-tested history and process replay passed in 95s locally.
  'test/cognition-coder-project-runtime.test.js',
  // Real sealed history, two native acceptance arms and process replay exceed 90s.
  'test/cognition-coder-outcome-runtime.test.js',
  // Three feedback arms plus a fresh-process native replay passed in 164s.
  'test/cognition-coder-runtime.test.js',
  'test/kernel-facade-contract.test.js',
  'test/coder-project-method-memory.test.js',
  // Native CLI restarts, a cold comparator, HTTP acceptance and tamper
  // refusals took 195s locally; retain the existing heavy-file deadline.
  'test/coder-revision-method-learning.test.js',
  // Real revision/update CLI runs, old-test veto and sealed transfer took
  // 166s locally while passing, exceeding the ordinary 90s per-file cap.
  'test/coder-route-updates.test.js',
  // Four fresh CLI runs exercise authorization, HTTP acceptance and an old-test
  // rollback veto; the first three alone took 80s locally.
  'test/coder-requirements-revision.test.js',
  // Three native CLI restarts and up to eight failed acceptance/rollback
  // attempts passed in 151s locally; retain the existing heavy-file deadline.
  'test/coder-string-synthesis.test.js',
  // Fresh CLI processes, sealed replay, independent vetoes and shared-budget
  // retry passed in 137s locally; use the existing heavy-file deadline.
  'test/coder-string-learning.test.js',
  // Native pipeline authority/refusal and eight acceptance/rollback attempts
  // passed in 133s locally; use the existing install-scale deadline.
  'test/coder-pipeline-synthesis.test.js',
  // cognitive-lab-b4-transfer replays the locked B4 transfer corpus and was
  // SIGTERM-killed at 98.981s on the Windows Node 24 shard PRs run (#3943).
  // On Node 22 locally it passes in 11-20s, so the cost is runner/Node
  // variance, not a hang.
  'test/cognitive-lab-b4-transfer.test.js',
  // production-http-adversarial boots a full server process per case -- seven
  // of them -- and was SIGTERM-killed at 90.883s on the Windows Node 22 shard
  // of main (54559c77), reddening a commit that never touched it. It passes
  // in 7s locally, so the cost is the loaded Windows runner, not a hang: the
  // same shape as the entry above, and the same remedy.
  'test/production-http-adversarial.test.js',
  // memory-store-sqlite-collection was SIGTERM-killed at 102.266s on the
  // windows-latest Node 24 shard 2 of PR #4210 (job 120389387431), and it
  // passes in 2.7s locally. Its sibling memory-store-sqlite took 7.6s for a
  // single case on the same runner, so the cost is the loaded Windows disk,
  // not a hang: the same shape as the two entries above.
  'test/memory-store-sqlite-collection.test.js',
  // plugins/repo-memory spawns git for each fixture and was SIGTERM-killed at
  // 102.716s on the windows-latest Node 24 shard 4 of PR #4210 (job
  // 120398835073). The same file finished in about 12s on the same runner an
  // hour earlier (job 120389387339) and takes 2.5s locally, so the cost is the
  // loaded runner, not a hang.
  'plugins/repo-memory.test.js',
  'test/external-action-gate-install.test.js',
  'test/v5-c5-external-conformance.test.js',
  'test/ui-conflict-triage-browser-smoke.test.js',
  // cognitive-lab-g1 builds a real git source and replays the holdout: 67.2s on
  // #4398 windows shard 5, SIGTERM-killed at 90.8s on #4399 windows shard 2.
  'test/cognitive-lab-g1.test.js',
  // G3 power + repeated cost (#4416) runs three full paired passes over two
  // families with a CPU probe per child: 55s locally on Node 24, and the same
  // loaded-Windows-runner variance that reddened the entries above applies.
  'test/coder-learning-g3-power-cost.test.js',
  // M5 G2 (#4068) runs 79 real `cli.js coder` child processes (1 training + 30
  // trust warm-up + 48 paired), which is the frozen N=24/30 protocol and cannot
  // be shortened. It passes in 60s locally on Node 24 and was SIGTERM-killed at
  // the 90s cap on the windows-latest Node 24 shard 2 of PR #4422: the same
  // loaded-runner variance as the entries above, not a hang.
  'test/cognitive-lab-m5-g2.test.js',
  // G3 enlarged sealed-run cohort (#4449) runs 142 real `cli.js coder` child
  // processes (2 training + 2x70 paired) at the frozen N=70 protocol, which
  // cannot be shortened without dropping below the margin-provable size (59).
  // It passes in 112s locally on Node 24, so the ordinary 90s cap would kill a
  // file that is still working.
  'test/g3-sealed-run-cohort-result.test.js',
]));

function fileTimeoutMs(relativePath) {
  if (Object.hasOwn(HEAVY_FILE_TIMEOUT_OVERRIDES, relativePath)) {
    return HEAVY_FILE_TIMEOUT_OVERRIDES[relativePath];
  }
  return HEAVY_FILES.has(relativePath) ? HEAVY_FILE_TIMEOUT_MS : DEFAULT_FILE_TIMEOUT_MS;
}

module.exports = {
  DEFAULT_FILE_TIMEOUT_MS,
  HEAVY_FILE_TIMEOUT_MS,
  HEAVY_FILE_TIMEOUT_OVERRIDES,
  HEAVY_FILES,
  fileTimeoutMs,
};
