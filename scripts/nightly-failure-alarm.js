'use strict';

/**
 * Open (or update) a GitHub issue when the nightly full-suite run goes red.
 *
 * The nightly cron run is the only run that executes every known test: the
 * per-pull-request checks run the *selected* shards, so a test nobody's change
 * touched can sit red on main indefinitely (#1947, #1949). That safety net was
 * already in place and already catching things -- three of the twelve nightly
 * runs before 2026-09-08 were red -- and nobody found out, because the workflow
 * had no failure path at all. A run that fails where no one looks is not a net.
 *
 * The failures are read from the per-shard sidecar written by
 * scripts/run-test-shard.js, NOT from the uploaded JUnit report. The report is
 * merged from <testsuite> blocks, and a test file that declares only top-level
 * `test(...)` calls emits none -- so its results, passing and failing alike,
 * are dropped. On 2026-09-05 shard 5 exited non-zero on
 * test/enforcement-coverage.test.js while its report said failures="0". An
 * alarm built on that report would have reported a green suite for a red run,
 * which is the exact failure mode this file exists to prevent.
 */

const fs = require('node:fs');
const path = require('node:path');

// The shared title, used only when a red run named no failing file. Everything
// else is keyed on the file itself -- see alarmTitleForFile.
const ALARM_TITLE = 'Nightly full-suite run is red';
const UNREADABLE_TITLE = 'Nightly red: a shard sidecar could not be read';
const SIDECAR_PATTERN = /^test-shard-(\d+)-failures\.json$/;

/**
 * Read every shard sidecar under `dir` and return one flat, shard-ordered list.
 * A sidecar that cannot be parsed is reported as a failure of its own rather
 * than skipped: "we could not tell what broke" has to reach the issue too.
 */
function collectFailedFiles(dir) {
  const entries = [];
  let names = [];
  try {
    names = fs.readdirSync(dir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && SIDECAR_PATTERN.test(entry.name))
      .map((entry) => ({ name: entry.name, full: path.join(entry.parentPath || entry.path || dir, entry.name) }));
  } catch {
    return entries;
  }
  for (const { name, full } of names) {
    const shard = Number(name.match(SIDECAR_PATTERN)[1]);
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(full, 'utf8'));
    } catch (error) {
      entries.push({
        shard,
        file: `(unreadable sidecar: ${error.message})`,
        status: null,
        unreadable: true,
      });
      continue;
    }
    const failed = Array.isArray(parsed.failedFiles) ? parsed.failedFiles : [];
    for (const item of failed) {
      entries.push({ shard, file: String(item.file), status: item.status ?? null });
    }
  }
  return entries.sort((a, b) => a.shard - b.shard || a.file.localeCompare(b.file));
}

function buildIssueBody({ runId, runUrl, sha, failedFiles }) {
  const lines = [
    `The nightly full-suite run is red on \`main\`.`,
    '',
    `- Run: ${runUrl} (\`${runId}\`)`,
    `- Commit: \`${sha}\``,
    '',
  ];
  if (failedFiles.length === 0) {
    lines.push(
      'No per-file failure was recorded by any shard, so the run failed outside the',
      'test files themselves -- the impact plan, `npm ci`, or a shard that was killed.',
      'Open the run and read the job logs.',
    );
  } else {
    lines.push('Failing test files:', '');
    for (const entry of failedFiles) {
      lines.push(`- \`${entry.file}\` (shard ${entry.shard}${entry.status === null ? '' : `, exit ${entry.status}`})`);
    }
    lines.push(
      '',
      'Reproduce one file locally with:',
      '',
      '```',
      'node scripts/run-tests.js <file>',
      '```',
    );
  }
  lines.push(
    '',
    'This issue is opened by the `nightly-failure-alarm` job in `benchmark.yml`,',
    'one issue per failing file. While it stays open, later red nightlies on the',
    'same file add a comment instead of a new issue.',
  );
  return lines.join('\n');
}

function alarmTitleForFile(file) {
  return `Nightly red: ${file}`;
}

/**
 * One issue per failing file, not one per night.
 *
 * The first version filed a single issue titled "Nightly full-suite run is red"
 * and reused it while open. Closing it after a fix meant the next red night
 * opened a fresh one -- #2030, #2088 and #2101 were three unrelated defects
 * under one title in three days -- and any night with two broken files put two
 * separate fixes in one thread. Keying the title on the file gives each defect
 * its own thread, so a file that is still broken keeps collecting evidence in
 * one place and a file that is fixed simply stops appearing.
 *
 * Grouping is by file rather than by (file, shard): the same file failing on two
 * shards is one defect reported twice, and its shards belong in one body.
 */
function planAlarmActions({ runId, runUrl, sha, failedFiles, openIssues }) {
  const entries = failedFiles || [];
  if (entries.length === 0) {
    // No file to key a title on. Still report it: a run that failed in the
    // impact plan, `npm ci`, or a killed shard is exactly the blindness this
    // alarm exists to remove.
    return [buildAction({ title: ALARM_TITLE, entries, runId, runUrl, sha, openIssues })];
  }

  const groups = new Map();
  for (const entry of entries) {
    const title = entry.unreadable === true ? UNREADABLE_TITLE : alarmTitleForFile(entry.file);
    if (!groups.has(title)) groups.set(title, []);
    groups.get(title).push(entry);
  }

  return [...groups].map(([title, grouped]) => buildAction({
    title, entries: grouped, runId, runUrl, sha, openIssues,
  }));
}

function buildAction({ title, entries, runId, runUrl, sha, openIssues }) {
  const existing = (openIssues || []).find((issue) => issue.title === title);
  return {
    kind: existing ? 'comment' : 'create',
    number: existing ? existing.number : null,
    title,
    body: buildIssueBody({ runId, runUrl, sha, failedFiles: entries }),
  };
}

module.exports = {
  ALARM_TITLE,
  UNREADABLE_TITLE,
  alarmTitleForFile,
  buildIssueBody,
  collectFailedFiles,
  planAlarmActions,
};

if (require.main === module) {
  // argv: <sidecar dir> [open-issues json produced by `gh issue list --json`]
  const dir = process.argv[2] || 'artifacts';
  let openIssues = [];
  if (process.argv[3]) {
    try {
      openIssues = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'));
    } catch (error) {
      // An unreadable issue list must not silence the alarm; opening a possible
      // duplicate is strictly better than reporting nothing.
      console.error(`warning: could not read the open issue list: ${error.message}`);
    }
  }
  const actions = planAlarmActions({
    runId: process.env.GITHUB_RUN_ID || 'unknown',
    runUrl: `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${process.env.GITHUB_REPOSITORY || ''}/actions/runs/${process.env.GITHUB_RUN_ID || ''}`,
    sha: process.env.GITHUB_SHA || 'unknown',
    failedFiles: collectFailedFiles(dir),
    openIssues,
  });
  process.stdout.write(`${JSON.stringify(actions)}\n`);
}
