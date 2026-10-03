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
const DEFAULT_CHILDREN = 2;
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
  let attempts = 0;
  let failures = 0;
  let firstFailure = null;

  if (target === 'memory') {
    const MemoryStore = require('../lib/memory-store');
    const store = new MemoryStore({ useSQLite: true, dbPath });
    for (let i = 0; i < writes; i += 1) {
      attempts += 1;
      try {
        store.store({ content: `${label}-${i}`, workspaceId: 'contention' });
      } catch (error) {
        failures += 1;
        if (!firstFailure) firstFailure = `${error.code || ''} ${error.message}`.trim();
      }
    }
    store.close();
  } else {
    const Graph = require('../graph');
    const memoryPath = dbPath.replace(/\.db$/, '.json');
    const graph = new Graph({ useSQLite: true, memoryPath, dbPath });
    for (let i = 0; i < writes; i += 1) {
      attempts += 1;
      try {
        const from = `${label}-n${i}`;
        const to = `${label}-n${i + 1}`;
        graph.addNode(from, 'bench', null, {});
        graph.addNode(to, 'bench', null, {});
        graph.addEdge(from, to, 'RELATES_TO', {});
      } catch (error) {
        failures += 1;
        if (!firstFailure) firstFailure = `${error.code || ''} ${error.message}`.trim();
      }
    }
    graph.closeSqlite();
  }

  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  process.stdout.write(`${JSON.stringify({ label, attempts, failures, firstFailure, elapsedMs })}\n`);
}

function runTarget(target, { children, writesPerChild, verbose }) {
  const dir = tempDir(`huqan-contention-${target}-`);
  const ext = target === 'memory' ? 'db' : 'graph.db';
  const contendedPath = path.join(dir, `contended.${ext}`);
  const soloPath = path.join(dir, `solo.${ext}`);

  const contendedStart = process.hrtime.bigint();
  const contended = [];
  for (let c = 0; c < children; c += 1) {
    contended.push(runChild(target, contendedPath, writesPerChild, `c${c}`));
  }
  const contendedMs = Number(process.hrtime.bigint() - contendedStart) / 1e6;

  const soloStart = process.hrtime.bigint();
  const solo = runChild(target, soloPath, writesPerChild * children, 'solo');
  const soloMs = Number(process.hrtime.bigint() - soloStart) / 1e6;

  const attempts = contended.reduce((sum, r) => sum + r.attempts, 0);
  const failures = contended.reduce((sum, r) => sum + r.failures, 0);
  const failureExamples = contended
    .filter((r) => r.firstFailure)
    .map((r) => `${r.label}: ${r.firstFailure}`);

  if (verbose) {
    process.stderr.write(
      `[${target}] children=${children} writes/child=${writesPerChild} `
      + `contended=${contendedMs.toFixed(1)}ms solo=${soloMs.toFixed(1)}ms\n`,
    );
  }

  return {
    target,
    children,
    writesPerChild,
    totalWrites: attempts,
    contendedMs: Number(contendedMs.toFixed(1)),
    soloMs: Number(soloMs.toFixed(1)),
    slowdownX: soloMs > 0 ? Number((contendedMs / soloMs).toFixed(2)) : null,
    writesPerSecond: contendedMs > 0 ? Number((attempts / (contendedMs / 1000)).toFixed(1)) : null,
    sqliteBusyFailures: failures,
    failureExamples,
  };
}

function main() {
  const children = Math.min(MAX_CHILDREN, Math.max(2, parseArg('children', DEFAULT_CHILDREN)));
  const writesPerChild = Math.max(1, parseArg('writes', DEFAULT_WRITES_PER_CHILD));
  const verbose = process.argv.includes('--verbose');
  const targets = process.argv.includes('--target=memory')
    ? ['memory']
    : process.argv.includes('--target=graph')
      ? ['graph']
      : ['graph', 'memory'];

  const results = targets.map((target) => runTarget(target, { children, writesPerChild, verbose }));

  const report = { version: VERSION, generatedAt: new Date().toISOString(), children, writesPerChild, results };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  const totalFailures = results.reduce((sum, r) => sum + r.sqliteBusyFailures, 0);
  if (totalFailures > 0) {
    process.stderr.write(`\n${totalFailures} write(s) failed under contention.\n`);
    process.exitCode = 1;
  }
}

if (process.argv.includes('--child')) childMain();
else main();

module.exports = { runTarget, childMain };
