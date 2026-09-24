'use strict';

// Baseline-freshness measurement for scripts/agent-context.js (#2221): how
// old the local origin/main may be, how the max age is configured, where a
// fetch leaves its trace, and the FRESH/STALE/UNKNOWN/UNMEASURED_BY_CONFIG
// verdict. Moved out of agent-context.js unchanged.

const fs = require('node:fs');
const path = require('node:path');
const { repoRoot, runGit, contextConflict } = require('./agent-context-primitives');

/**
 * How old the local `origin/main` may be before this guard stops trusting it.
 *
 * The ancestry check below reads `origin/main`, which is a local ref that only
 * moves when something fetches. Over a long session it goes quietly out of date
 * and the check keeps passing -- against a baseline that is no longer the one
 * CI will measure. Same head, green locally, red in CI (#682). Nothing about
 * the ancestry answer is wrong; it is answered about the wrong `main`.
 *
 * So the age of the reference is measured too, and a reference too old to
 * stand for the remote is a conflict rather than a pass. Thirty minutes is
 * chosen to be shorter than the sessions where this actually bites; the remedy
 * is one fetch.
 */
const DEFAULT_BASELINE_MAX_AGE_MINUTES = 30;
const BASELINE_REFRESH_COMMAND = 'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main';

/**
 * Air-gapped work is legitimate, and this guard needs no network -- it reads
 * mtimes. What it cannot do offline is tell a fresh baseline from an old one,
 * so `HUQAN_BASELINE_MAX_AGE_MINUTES=0` turns the measurement off explicitly.
 * That is not the same as passing: the capsule then reports
 * `UNMEASURED_BY_CONFIG`, so "I did not measure this" stays readable in the
 * output instead of looking like "I measured it and it was fine".
 */
function resolveBaselineMaxAgeMs(env = process.env) {
  const raw = env.HUQAN_BASELINE_MAX_AGE_MINUTES;
  if (raw === undefined || raw === '') return DEFAULT_BASELINE_MAX_AGE_MINUTES * 60000;
  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) {
    throw contextConflict(
      `HUQAN_BASELINE_MAX_AGE_MINUTES must be a non-negative number of minutes, observed ${JSON.stringify(raw)}`,
    );
  }
  return minutes * 60000;
}

/**
 * Files git touches when it syncs the baseline with the remote.
 *
 * `FETCH_HEAD` is rewritten by every fetch, including one that finds nothing
 * new -- which is the case that matters, since a repository whose `main` has
 * not moved is still being checked. The loose ref covers the opposite case, a
 * fetch that did move the ref. `packed-refs` is deliberately not consulted:
 * `git gc` rewrites it without contacting anything, so it would report a sync
 * that never happened.
 */
function baselineSyncPaths() {
  const dirs = new Set();
  for (const arg of ['--git-dir', '--git-common-dir']) {
    try {
      dirs.add(path.resolve(repoRoot, runGit(['rev-parse', arg])));
    } catch {
      // A missing common dir just means there is one fewer place to look.
    }
  }

  const candidates = [];
  for (const dir of dirs) {
    candidates.push(path.join(dir, 'FETCH_HEAD'));
    candidates.push(path.join(dir, 'refs', 'remotes', 'origin', 'main'));
  }
  return candidates;
}

function readBaselineSyncedAt(candidates = baselineSyncPaths()) {
  let newest = null;
  for (const candidate of candidates) {
    let stat;
    try {
      stat = fs.statSync(candidate);
    } catch {
      continue;
    }
    if (newest === null || stat.mtimeMs > newest) newest = stat.mtimeMs;
  }
  return newest;
}

function assessBaselineFreshness(baselineSyncedAt, { now, maxAgeMs }) {
  if (maxAgeMs === 0) {
    return { verdict: 'UNMEASURED_BY_CONFIG', syncedAt: null, ageMinutes: null };
  }
  if (typeof baselineSyncedAt !== 'number' || !Number.isFinite(baselineSyncedAt)) {
    return { verdict: 'UNKNOWN', syncedAt: null, ageMinutes: null };
  }
  const ageMs = now - baselineSyncedAt;
  return {
    verdict: ageMs > maxAgeMs ? 'STALE' : 'FRESH',
    syncedAt: new Date(baselineSyncedAt).toISOString(),
    ageMinutes: Math.max(0, Math.round(ageMs / 60000)),
  };
}

module.exports = {
  DEFAULT_BASELINE_MAX_AGE_MINUTES,
  BASELINE_REFRESH_COMMAND,
  resolveBaselineMaxAgeMs,
  baselineSyncPaths,
  readBaselineSyncedAt,
  assessBaselineFreshness,
};
