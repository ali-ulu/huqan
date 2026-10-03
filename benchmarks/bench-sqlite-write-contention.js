'use strict';

// #3314: measure multi-process SQLite write contention.
//
// `bench-memory-scale`, `bench-graph-save` and `bench-scale-10k` all measure a
// single process talking to its own handle, so none of them exercises the case
// the runtime actually ships: two long-lived processes sharing one database.
// SQLite serialises writers, so the question is not "is it correct" (WAL plus
// busy_timeout keeps it correct) but "how much throughput is lost, and does any
// write fail outright, when a second writer contends for the lock".
//
// Design: the parent seeds each target file, then forks N child processes that
// write into the same file concurrently, each inside its own process and its
// own SQLite handle. The parent measures wall-clock for the contended run and
// compares it with a single-process run of the same total write count, so the
// reported slowdown is independent of the machine's absolute speed.
//
// Targets (both are real product write paths, not synthetic tables):
//   graph  -- Graph with SQLite enabled; each child addNode()/addEdge()s.
//   memory -- MemoryStore with SQLite enabled; each child store()s records,
//             whose JSON persistence rewrites state per store.
//
// The default child count is 2 (the minimal contended case). `--children=N`
// raises it. The default write budget is 40 per child so a local run stays
// under a second; it is small on purpose, because the goal is the relative
// cost, not an endurance figure.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const VERSION = '1.0.0';
const DEFAULT_SIZES = [1, 2, 4, 8];
const DEFAULT_WRITES_PER_CHILD = 40;
const MAX_CHILDREN = 16;

const tempDirs = new Set();

process.once('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function parseArg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (!hit) return fallback;
  const value = Number(hit.slice(prefix.length));
  return Number.isFinite(value) ? value : fallback;
}

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

// The child is this same file re-executed with --child, so there is one source
// of truth for how a write is performed and no second file to drift.
function runChild(target, dbPath, writes, label) {
  const result = spawnSync(
    process.execPath,
    [__filename, '--child', `--target=${target}`, `--db=${dbPath}`, `--writes=${writes}`, `--label=${label}`],
    { encoding: 'utf8', timeout: 120000 },
  );
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`child ${label} exited ${result.status}: ${(result.stderr || '').trim()}`);
  }
  const line = (result.stdout || '').trim().split('\n').filter(Boolean).pop();
  try {
    return JSON.parse(line);
  } catch (error) {
    throw new Error(`child ${label} produced no JSON summary: ${(result.stdout || '').trim()}`);
  }
}

function childMain() {
  const dbPath = process.argv.find((a) => a.startsWith('--db=')).slice(5);
  const target = process.argv.find((a) => a.startsWith('--target=')).slice(9);
  const writes = Number(process.argv.find((a) => a.startsWith('--writes=')).slice(9));
  const label = process.argv.find((a) => a.startsWith('--label=')).slice(8);

  const started = process.hrtime.bigint();
  const latencies = [];
  let attempts = 0;
  let failures = 0;
  let firstFailure = null;

  if (target === 'memory') {
    const MemoryStore = require('../lib/memory-store');
    const store = new MemoryStore({ useSQLite: true, dbPath });
    for (let i = 0; i < writes; i += 1) {
      attempts += 1;
      const t0 = process.hrtime.bigint();
      try {
        store.store({ content: `${label}-${i}`, workspaceId: 'contention' });
      } catch (error) {
        failures += 1;
        if (!firstFailure) firstFailure = `${error.code || ''} ${error.message}`.trim();
      }
      latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    store.close();
  } else {
    const Graph = require('../graph');
    const memoryPath = dbPath.replace(/\.db$/, '.json');
    const graph = new Graph({ useSQLite: true, memoryPath, dbPath });
    for (let i = 0; i < writes; i += 1) {
      attempts += 1;
      const of = `${label}-n${i}`;
      const ot = `${label}-n${i + 1}`;
      const t0 = process.hrtime.bigint();
      try {
        graph.addNode(of, 'bench', null, {});
        graph.addNode(ot, 'bench', null, {});
        graph.addEdge(of, ot, 'RELATES_TO', {});
      } catch (error) {
        failures += 1;
        if (!firstFailure) firstFailure = `${error.code || ''} ${error.message}`.trim();
      }
      // better-sqlite3 is synchronous, so one iteration's wall time is also the
      // longest the process's event loop is blocked waiting for (or doing) the
      // write.
      latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    graph.closeSqlite();
  }

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  // Latencies are rounded to 0.1 ms; the parent only needs the distribution.
  const rounded = latencies.map((ms) => Number(ms.toFixed(1)));
  process.stdout.write(`${JSON.stringify({ label, attempts, failures, firstFailure, elapsedMs, latencies: rounded })}\n`);
}

// Nearest-rank percentile on a small sorted sample. Returns ms to 0.1.
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return Number(sorted[index].toFixed(1));
}

function summarizeLatencies(latencies) {
  if (latencies.length === 0) {
    return { p50Ms: null, p95Ms: null, p99Ms: null, maxEventLoopBlockMs: null };
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  return {
    p50Ms: percentile(sorted, 50),
    p95Ms: percentile(sorted, 95),
    p99Ms: percentile(sorted, 99),
    // better-sqlite3 is synchronous: the slowest iteration is the longest the
    // process's event loop was unavailable.
    maxEventLoopBlockMs: percentile(sorted, 100),
  };
}

function runOnce(target, pathForFile, children, writesPerChild, verbose) {
  const start = process.hrtime.bigint();
  const procs = [];
  for (let c = 0; c < children; c += 1) {
    procs.push(runChild(target, pathForFile, writesPerChild, `c${c}`));
  }
  const wallMs = Number(process.hrtime.bigint() - start) / 1e6;

  const attempts = procs.reduce((sum, r) => sum + r.attempts, 0);
  const failures = procs.reduce((sum, r) => sum + r.failures, 0);
  const latencies = procs.flatMap((r) => r.latencies || []);
  const failureExamples = procs
    .filter((r) => r.firstFailure)
    .map((r) => `${r.label}: ${r.firstFailure}`);

  if (verbose) {
    process.stderr.write(
      `[${target}] n=${children} writes=${attempts} wall=${wallMs.toFixed(1)}ms `
      + `failures=${failures}\n`,
    );
  }

  return {
    children,
    writesPerChild,
    totalWrites: attempts,
    wallMs: Number(wallMs.toFixed(1)),
    writesPerSecond: wallMs > 0 ? Number((attempts / (wallMs / 1000)).toFixed(1)) : null,
    ...summarizeLatencies(latencies),
    sqliteBusyFailures: failures,
    failureExamples,
  };
}

function runTarget(target, { sizes, writesPerChild, verbose }) {
  const dir = tempDir(`huqan-contention-${target}-`);
  const ext = target === 'memory' ? 'db' : 'graph.db';
  const contendedPath = path.join(dir, `contended.${ext}`);
  const soloPath = path.join(dir, `solo.${ext}`);

  // One process writing the largest volume is the uncontended reference; its
  // time is scaled linearly to the volume each contended size writes, so the
  // slowdown compares like with like rather than a small contended run against
  // a large solo run.
  const maxWrites = writesPerChild * Math.max(...sizes);
  const soloStart = process.hrtime.bigint();
  runChild(target, soloPath, maxWrites, 'solo');
  const soloMs = Number(process.hrtime.bigint() - soloStart) / 1e6;
  const soloPerWriteMs = soloMs / maxWrites;

  const perN = sizes.map((n) => {
    const run = runOnce(target, contendedPath, n, writesPerChild, verbose);
    const expectedSoloMs = soloPerWriteMs * run.totalWrites;
    return {
      ...run,
      soloMs: Number(soloMs.toFixed(1)),
      slowdownX: expectedSoloMs > 0 ? Number((run.wallMs / expectedSoloMs).toFixed(2)) : null,
    };
  });

  return { target, writesPerChild, soloMs: Number(soloMs.toFixed(1)), perN };
}

function main() {
  const requested = parseArg('children', null);
  const sizes = requested !== null
    ? [Math.min(MAX_CHILDREN, Math.max(1, requested))]
    : DEFAULT_SIZES;
  const writesPerChild = Math.max(1, parseArg('writes', DEFAULT_WRITES_PER_CHILD));
  const verbose = process.argv.includes('--verbose');
  const targets = process.argv.includes('--target=memory')
    ? ['memory']
    : process.argv.includes('--target=graph')
      ? ['graph']
      : ['graph', 'memory'];

  const results = targets.map((target) => runTarget(target, { sizes, writesPerChild, verbose }));

  const report = { version: VERSION, generatedAt: new Date().toISOString(), sizes, writesPerChild, results };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  const totalFailures = results.reduce(
    (sum, r) => sum + r.perN.reduce((s, n) => s + n.sqliteBusyFailures, 0),
    0,
  );
  if (totalFailures > 0) {
    process.stderr.write(`\n${totalFailures} write(s) failed under contention.\n`);
    process.exitCode = 1;
  }
}

if (process.argv.includes('--child')) childMain();
else main();

module.exports = { runTarget, runOnce, childMain, summarizeLatencies };
