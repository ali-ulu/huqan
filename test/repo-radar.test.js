'use strict';

/**
 * Contract tests for the Repo Radar selector (docs/automations/repo-radar.md).
 *
 * The rotation is what makes the hourly automation reproducible, so the two
 * properties that matter are pinned here: the same hour always resolves to the
 * same repository, and a malformed target list refuses to run rather than
 * silently shrinking (which would shift every later hour's selection).
 */

const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  loadTargets,
  selectTarget,
  renderPrompt,
  parseArgs,
  DEFAULT_CONFIG,
} = require('../scripts/repo-radar/pick-target.js');

const HOUR_MS = 60 * 60 * 1000;

function withTempConfig(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'repo-radar-test-'));
  const file = path.join(dir, 'targets.json');
  fs.writeFileSync(file, contents);
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

describe('repo-radar target rotation', () => {
  const targets = loadTargets(DEFAULT_CONFIG);

  it('loads the versioned target list with valid entries', () => {
    assert.ok(targets.length >= 1);
    for (const entry of targets) {
      assert.match(entry.repo, /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/);
      assert.ok(entry.why && entry.why.trim().length > 0);
    }
  });

  it('is deterministic for every moment inside one UTC hour', () => {
    const start = Date.UTC(2026, 9, 1, 0, 0, 0);
    const a = selectTarget(targets, new Date(start));
    const b = selectTarget(targets, new Date(start + 30 * 60 * 1000));
    const c = selectTarget(targets, new Date(start + HOUR_MS - 1));
    assert.strictEqual(a.repo, b.repo);
    assert.strictEqual(a.repo, c.repo);
    assert.strictEqual(a.selectedForHour, '2026-10-01T00:00:00.000Z');
  });

  it('advances by exactly one target per hour and wraps after a full cycle', () => {
    const start = Date.UTC(2026, 9, 1, 0, 0, 0);
    for (let offset = 0; offset < targets.length; offset += 1) {
      const now = selectTarget(targets, new Date(start + offset * HOUR_MS));
      const expected = targets[(offset + Math.floor(start / HOUR_MS)) % targets.length].repo;
      assert.strictEqual(now.repo, expected);
    }
    const first = selectTarget(targets, new Date(start));
    const wrapped = selectTarget(targets, new Date(start + targets.length * HOUR_MS));
    assert.strictEqual(wrapped.repo, first.repo);
    assert.strictEqual(wrapped.index, first.index);
  });

  it('refuses a config whose repository entry is malformed', () => {
    const { file, cleanup } = withTempConfig(JSON.stringify({ repos: [{ repo: 'not-a-repo', why: 'x' }] }));
    after(cleanup);
    assert.throws(() => loadTargets(file), /owner\/name/);
  });

  it('refuses a config that repeats a repository', () => {
    const { file, cleanup } = withTempConfig(JSON.stringify({
      repos: [{ repo: 'a/b', why: 'x' }, { repo: 'a/b', why: 'y' }],
    }));
    after(cleanup);
    assert.throws(() => loadTargets(file), /duplicates/);
  });

  it('refuses an empty target list', () => {
    const { file, cleanup } = withTempConfig(JSON.stringify({ repos: [] }));
    after(cleanup);
    assert.throws(() => loadTargets(file), /at least one repository/);
  });
});

describe('repo-radar prompt rendering', () => {
  const targets = loadTargets(DEFAULT_CONFIG);

  it('names every rotated repository and pins no single target', () => {
    const prompt = renderPrompt(targets);
    for (const entry of targets) {
      assert.ok(prompt.includes(entry.repo), `prompt omits ${entry.repo}`);
    }
    assert.ok(prompt.includes('pick-target.js --json'));
  });
});

describe('repo-radar argument parsing', () => {
  it('rejects an unknown flag instead of guessing', () => {
    assert.throws(() => parseArgs(['--nope']), /unknown argument/);
  });

  it('parses the documented flags', () => {
    const opts = parseArgs(['--json', '--at', '2026-10-01T00:00:00Z']);
    assert.strictEqual(opts.json, true);
    assert.strictEqual(opts.at, '2026-10-01T00:00:00Z');
  });
});
