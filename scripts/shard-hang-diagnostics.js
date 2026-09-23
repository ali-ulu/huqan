'use strict';

/**
 * Running one test file under its deadline, and saying what happened if it never
 * ends (#2814).
 *
 * On 2026-09-23 four hangs across three PRs each cost a full CI cycle, and every
 * one of them left the shard log with a starting line, a timeout line, and
 * nothing between them: the child's only reporter (junit) writes when a file
 * finishes, which is the one thing a hanging file never does. Nothing could
 * distinguish "hung inside a subtest" from "hung in a before hook" from "every
 * test passed and an open handle kept the process alive".
 *
 * Two things fix that, and neither one widens a deadline:
 *
 *   1. a second reporter streams the same run to the job log, so the last line
 *      before the timeout says how far the file got;
 *   2. the deadline reads the child's process tree before it kills it, so a
 *      browser or a test server that outlived its file is in the log too.
 *
 * (2) is why this no longer uses spawnSync. Its own `timeout` kills and reaps the
 * child before ETIMEDOUT comes back -- measured, only `pid` and
 * `signal: 'SIGTERM'` survive -- so the tree the diagnostic is built on has
 * already been reparented and cannot be read. Only a live child can be
 * inspected, so the deadline has to be ours.
 */

const { spawn, spawnSync } = require('node:child_process');

// How long a timed-out file's children get to exit on their own before they are
// killed outright. A browser or a test server that outlives the file which
// spawned it is one of the hypotheses in #2814, and it also competes with the
// next file in the shard for the runner's two cores.
const KILL_GRACE_MS = 5_000;

// The tree probe runs on the timeout path only: a diagnostic must never become
// the hang it exists to explain.
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Parse a process table into `{pid, ppid, elapsed, command}` rows.
 *
 * Two shapes, because `ps` does not exist on Windows -- it fails with ENOENT,
 * which would have made this produce nothing at all on the Windows matrix legs
 * (#2450) -- so the Windows probe asks the OS through PowerShell and prints
 * `pid|ppid|command`. Pure, so the parsing is pinned by a test rather than by a
 * live hang.
 */
function parseProcessTable(text) {
  const rows = [];
  for (const line of String(text).split(/\r?\n/)) {
    if (line.trim() === '') continue;
    if (line.includes('|')) {
      const [pid, ppid, ...rest] = line.split('|');
      rows.push({ pid: Number(pid), ppid: Number(ppid), elapsed: null, command: rest.join('|').trim() });
      continue;
    }
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
    if (match) {
      rows.push({ pid: Number(match[1]), ppid: Number(match[2]), elapsed: match[3], command: match[4].trim() });
    }
  }
  return rows.filter(row => Number.isInteger(row.pid) && Number.isInteger(row.ppid));
}

/**
 * Every descendant of `rootPid`, parents before their children, with its depth.
 *
 * The depth is the point: it shows whether the browser outlived the test file
 * that spawned it -- a shape that stops being visible the moment the root is
 * reaped, and the file that hangs is exactly the one that gets reaped.
 */
function collectDescendants(rows, rootPid, maxRows = Infinity) {
  const byParent = new Map();
  for (const row of rows) {
    if (!byParent.has(row.ppid)) byParent.set(row.ppid, []);
    byParent.get(row.ppid).push(row);
  }
  const collected = [];
  const walk = (pid, depth) => {
    for (const row of byParent.get(pid) || []) {
      if (collected.length >= maxRows) return;
      collected.push({ row, depth });
      walk(row.pid, depth + 1);
    }
  };
  walk(rootPid, 0);
  return collected;
}

/**
 * The descendants of `rootPid` as indented lines, bounded so a process
 * explosion cannot flood the job log with the evidence of itself.
 */
function formatProcessTree(rows, rootPid, { maxRows = 20, maxCommand = 140 } = {}) {
  return collectDescendants(rows, rootPid, maxRows).map(({ row, depth }) => {
    const command = row.command.length > maxCommand ? `${row.command.slice(0, maxCommand)}...` : row.command;
    return `${'  '.repeat(depth)}pid ${row.pid} ppid ${row.ppid}${row.elapsed ? ` etime ${row.elapsed}` : ''} ${command}`;
  });
}

/** The live process table, or null when this platform cannot produce one. */
function readProcessTable() {
  const [command, args] = process.platform === 'win32'
    ? ['powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)|$($_.ParentProcessId)|$($_.CommandLine)" }',
    ]]
    : ['ps', ['-e', '-o', 'pid=,ppid=,etime=,args=']];
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS, windowsHide: true });
  if (result.error || typeof result.stdout !== 'string') return null;
  return parseProcessTable(result.stdout);
}

/** Terminate exactly one pid. Never a broad kill: only pids this shard parented. */
function terminatePid(pid, signal) {
  try {
    process.kill(pid, signal);
  } catch { /* already exited, or not ours to kill */ }
}

/**
 * Print the child's process tree and return the pids to terminate with it.
 *
 * Best-effort by design: a shard must not fail because a diagnostic refused to
 * run, so an unreadable table is reported as such and the timeout verdict
 * stands on its own.
 */
function reportChildTree(rootPid, shard, file) {
  const prefix = `[shard ${shard}]`;
  const table = readProcessTable();
  if (!table) {
    console.error(`${prefix} ${file} timed out; this platform produced no process table to explain it (#2814)`);
    return [];
  }
  const lines = formatProcessTree(table, rootPid);
  console.error(`${prefix} process tree under pid ${rootPid} when ${file} was killed (${lines.length} descendant${lines.length === 1 ? '' : 's'}, #2814):`);
  if (lines.length === 0) console.error(`${prefix}   (no descendant process: the file's own process was what hung)`);
  for (const line of lines) console.error(`${prefix}   ${line}`);
  return collectDescendants(table, rootPid).map(({ row }) => row.pid);
}

/**
 * The arguments for one test file inside a shard.
 *
 * Exported and pure because two properties of it are load-bearing and both are
 * easy to break silently: the junit pair must stay -- the merged report and the
 * nightly alarm sidecar read it -- and every `--test-reporter-destination`
 * binds to the reporter before it, so the streaming pair has to stay adjacent.
 */
function testArgsFor(file, partPath, concurrency) {
  return [
    '--test',
    `--test-concurrency=${concurrency}`,
    // The streaming half of #2814: the log has to show where a hanging file
    // stopped, including when it never stops.
    '--test-reporter=spec',
    '--test-reporter-destination=stdout',
    '--test-reporter=junit',
    `--test-reporter-destination=${partPath}`,
    file,
  ];
}

/**
 * Run one test file under its own deadline and say how it ended.
 *
 * The outcome keeps the shape callers already handled -- `error` for a child
 * that could not start, `status`/`signal` as the OS reported them -- plus
 * `timedOut`, which is ours rather than spawnSync's so that the process tree can
 * be read while the child is still alive (see the module note above).
 */
function runFileToDeadline({ cwd, file, partPath, concurrency, env, timeoutMs, shard }) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, testArgsFor(file, partPath, concurrency), {
      cwd,
      env,
      stdio: 'inherit',
    });
    let settled = false;
    let timedOut = false;
    let deadlineTimer = null;
    let killTimer = null;
    const settle = outcome => {
      if (settled) return;
      settled = true;
      clearTimeout(deadlineTimer);
      clearTimeout(killTimer);
      resolve(outcome);
    };
    // The deadline caps the indefinite "still running at 22m" (#1847) at the
    // file that actually hangs; the grace below only bounds the killing.
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      const descendants = reportChildTree(child.pid, shard, file);
      for (const pid of [child.pid, ...descendants]) terminatePid(pid, 'SIGTERM');
      // A process that ignores SIGTERM must not hold the whole shard: the
      // deadline bounds the run, and the report is written either way.
      killTimer = setTimeout(() => {
        for (const pid of [child.pid, ...descendants]) terminatePid(pid, 'SIGKILL');
        settle({ status: null, signal: 'SIGKILL', timedOut: true });
      }, KILL_GRACE_MS);
      killTimer.unref?.();
    }, timeoutMs);
    child.once('error', error => settle({ error }));
    child.once('exit', (status, signal) => settle({ status, signal, timedOut }));
  });
}

module.exports = {
  KILL_GRACE_MS,
  PROBE_TIMEOUT_MS,
  collectDescendants,
  formatProcessTree,
  parseProcessTable,
  runFileToDeadline,
  testArgsFor,
};
