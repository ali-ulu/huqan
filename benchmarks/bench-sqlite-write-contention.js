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
// write into the same file at the same time, each inside its own process and
// its own SQLite handle. Every child opens its handle, waits on a barrier, then
// runs the timed write loop, so all writers are connected before the first
// write lands. The parent waits for every child, and compares the contended
// write phase against a fresh single-process run of the same total write count,
// so the reported slowdown compares like with like instead of a small contended
// run against a large solo run.
//
// Targets (both are real product write paths, not synthetic tables):
//   graph  -- Graph with SQLite enabled; each child addNode()/addEdge()s.
//   memory -- MemoryStore with SQLite enabled; each child store()s records,
//             whose JSON persistence rewrites state per store.
//   graph-checkpoint -- one dedicated process repeatedly forces a full
//             checkpoint (load + save) while the other children write, which is
//             the "checkpoint under contention" case the issue asks for.
//
// The default child count is 2 (the minimal contended case). `--children=N`
// raises it. The default write budget is 40 per child so a local run stays
// short; it is small on purpose, because the goal is the relative cost, not an
// endurance figure.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { isSqliteBusyError } = require('../lib/sqlite-busy-retry');

const VERSION = '1.2.0';
// #3503: the sweep covers 1/2/4/8/16 writers; 16 is the MAX_CHILDREN cap and
// the top of the capacity envelope, not an opt-in extra.
const DEFAULT_SIZES = [1, 2, 4, 8, 16];
const DEFAULT_WRITES_PER_CHILD = 40;
const DEFAULT_CHECKPOINT_CYCLES = 4;
const MAX_CHILDREN = 16;
// Children sleep this long after opening their handle and before the timed
// write loop, so every writer is connected and waiting when the first write
// lands. Without it the first child can finish before the last has started.
const DEFAULT_BARRIER_MS = 500;

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

// Create and migrate the schema in the parent before any writer is spawned.
// SQLite's CREATE/ALTER migration is not safe to run from several processes at
// once on a brand-new file (they race to add the same column), so the file must
// exist with its schema already applied before the concurrent phase begins.
function seedTargetFile(target, dbPath) {
  if (target === 'memory') {
    const MemoryStore = require('../lib/memory-store');
    const store = new MemoryStore({ useSQLite: true, dbPath });
    store.close();
    return;
  }
  const Graph = require('../graph');
  const memoryPath = dbPath.replace(/\.db$/, '.json');
  const graph = new Graph({ useSQLite: true, memoryPath, dbPath });
  graph.closeSqlite();
}

function barrierWait(ms) {
  if (ms <= 0) return;
  // better-sqlite3 is synchronous, so a synchronous barrier is the honest way
  // to hold the process still without yielding to the event loop.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

// The child is this same file re-executed with --child, so there is one source
// of truth for how a write is performed and no second file to drift. Children
// are started asynchronously so all N writers run at the same time.
function spawnChild(target, dbPath, writes, label, barrierMs) {
  return new Promise((resolve, reject) => {
    const args = [
      __filename, '--child', `--target=${target}`, `--db=${dbPath}`,
      `--writes=${writes}`, `--label=${label}`, `--barrier=${barrierMs}`,
    ];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child ${label} timed out`));
    }, 120000);
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`child ${label} exited ${code}: ${stderr.trim()}`));
        return;
      }
      const line = stdout.trim().split('\n').filter(Boolean).pop();
      try {
        resolve(JSON.parse(line));
      } catch (error) {
        reject(new Error(`child ${label} produced no JSON summary: ${stdout.trim()}`));
      }
    });
  });
}

// Count a failure once, by whether it is a retry-exhausted lock error or some
// other write error, so a non-busy error cannot masquerade as a lock threshold.
function classifyFailure(error, state) {
  const busy = isSqliteBusyError(error);
  if (busy) state.busyFailures += 1;
  else state.otherFailures += 1;
  if (!state.firstFailure) {
    const code = error && error.code ? error.code : '';
    const message = error && error.message ? error.message : String(error);
    state.firstFailure = `${busy ? 'SQLITE_BUSY' : 'WRITE_ERROR'} ${code} ${message}`.trim();
  }
}

function emit(payload) {
  // Latencies are rounded to 0.1 ms; the parent only needs the distribution.
  const rounded = payload.latencies.map((ms) => Number(ms.toFixed(1)));
  process.stdout.write(`${JSON.stringify({ ...payload, latencies: rounded })}\n`);
}

function childMain() {
  const argOf = (name) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : '';
  };
  const dbPath = argOf('db');
  const target = argOf('target');
  const writes = Number(argOf('writes'));
  const label = argOf('label');
  const barrierMs = Math.max(0, Number(argOf('barrier')) || 0);

  const state = { busyFailures: 0, otherFailures: 0, firstFailure: null };
  const latencies = [];
  let attempts = 0;
  let checkpointMs = null;

  if (target === 'memory') {
    const MemoryStore = require('../lib/memory-store');
    const store = new MemoryStore({ useSQLite: true, dbPath });
    barrierWait(barrierMs);
    const started = process.hrtime.bigint();
    for (let i = 0; i < writes; i += 1) {
      attempts += 1;
      const t0 = process.hrtime.bigint();
      try {
        const result = store.store({ content: `${label}-${i}`, workspaceId: 'contention' });
        // store() reports a persistence failure as { ok: false, error } rather
        // than throwing, so the returned envelope has to be checked too.
        if (result && result.ok === false) classifyFailure(result.error, state);
      } catch (error) {
        classifyFailure(error, state);
      }
      latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    store.close();
    emit({ label, attempts, ...state, checkpointMs, elapsedMs, latencies });
    return;
  }

  const Graph = require('../graph');
  const memoryPath = dbPath.replace(/\.db$/, '.json');
  const graph = new Graph({ useSQLite: true, memoryPath, dbPath });
  barrierWait(barrierMs);
  const started = process.hrtime.bigint();

  if (target === 'graph-checkpoint') {
    // This process does no ordinary writes; it repeatedly forces a full
    // checkpoint (load resets the delta, save rewrites every row) so its long
    // write-lock hold overlaps the other children's writes.
    for (let i = 0; i < writes; i += 1) {
      attempts += 1;
      const t0 = process.hrtime.bigint();
      try {
        graph.load();
        graph.save();
      } catch (error) {
        classifyFailure(error, state);
      }
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      latencies.push(ms);
      if (checkpointMs === null || ms > checkpointMs) checkpointMs = ms;
    }
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    graph.closeSqlite();
    emit({ label, attempts, ...state, checkpointMs, elapsedMs, latencies });
    return;
  }

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
      classifyFailure(error, state);
    }
    // better-sqlite3 is synchronous, so one iteration's wall time is also the
    // longest the process's event loop is blocked waiting for (or doing) the
    // write.
    latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  graph.closeSqlite();
  emit({ label, attempts, ...state, checkpointMs, elapsedMs, latencies });
}

// Nearest-rank percentile on a small sorted sample. Returns ms to 0.1.
function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length) - 1;
  const index = Math.min(sorted.length - 1, Math.max(0, rank));
  return Number(sorted[index].toFixed(1));
}

function maxOf(latencies) {
  if (latencies.length === 0) return null;
  return percentile([...latencies].sort((a, b) => a - b), 100);
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

// Run `children` writers against one file concurrently and return the aggregate
// plus each process's own longest block, so the report can name the process
// that blocked longest rather than only the merged maximum.
async function runOnce(target, pathForFile, children, writesPerChild, verbose, barrierMs = DEFAULT_BARRIER_MS) {
  const start = process.hrtime.bigint();
  const procs = await Promise.all(
    Array.from({ length: children }, (_, c) => spawnChild(target, pathForFile, writesPerChild, `c${c}`, barrierMs)),
  );
  const wallMs = Number(process.hrtime.bigint() - start) / 1e6;

  const attempts = procs.reduce((sum, r) => sum + r.attempts, 0);
  const busyFailures = procs.reduce((sum, r) => sum + r.busyFailures, 0);
  const otherFailures = procs.reduce((sum, r) => sum + r.otherFailures, 0);
  const latencies = procs.flatMap((r) => r.latencies || []);
  const failureExamples = procs
    .filter((r) => r.firstFailure)
    .map((r) => `${r.label}: ${r.firstFailure}`);
  // The write phase ends when the last writer finishes; spawn and barrier wait
  // are excluded so contended and solo runs compare like with like.
  const writePhaseMs = procs.reduce((max, r) => Math.max(max, r.elapsedMs), 0);

  if (verbose) {
    process.stderr.write(
      `[${target}] n=${children} writes=${attempts} phase=${writePhaseMs.toFixed(1)}ms `
      + `wall=${wallMs.toFixed(1)}ms busy=${busyFailures} other=${otherFailures}\n`,
    );
  }

  return {
    children,
    writesPerChild,
    totalWrites: attempts,
    wallMs: Number(wallMs.toFixed(1)),
    writePhaseMs: Number(writePhaseMs.toFixed(1)),
    writesPerSecond: writePhaseMs > 0 ? Number((attempts / (writePhaseMs / 1000)).toFixed(1)) : null,
    ...summarizeLatencies(latencies),
    sqliteBusyFailures: busyFailures,
    otherFailures,
    processes: procs.map((r) => ({
      label: r.label,
      attempts: r.attempts,
      elapsedMs: Number(r.elapsedMs.toFixed(1)),
      maxBlockMs: maxOf(r.latencies || []),
      sqliteBusyFailures: r.busyFailures,
      otherFailures: r.otherFailures,
    })),
    failureExamples,
  };
}

async function runTarget(target, { sizes, writesPerChild, verbose }) {
  const dir = tempDir(`huqan-contention-${target}-`);
  const ext = target === 'memory' ? 'db' : 'graph.db';
  const contendedPath = path.join(dir, `contended.${ext}`);
  const soloPath = path.join(dir, `solo.${ext}`);
  seedTargetFile(target, contendedPath);
  seedTargetFile(target, soloPath);

  const perN = [];
  for (const n of sizes) {
    const run = await runOnce(target, contendedPath, n, writesPerChild, verbose);
    // A fresh single-process run at the same total write count, so fixed
    // per-process costs do not distort the slowdown.
    const solo = await spawnChild(target, soloPath, run.totalWrites, 'solo', 0);
    const soloMs = Number(solo.elapsedMs.toFixed(1));
    perN.push({
      ...run,
      soloMs,
      slowdownX: soloMs > 0 ? Number((run.writePhaseMs / soloMs).toFixed(2)) : null,
    });
  }

  return { target, writesPerChild, perN };
}

// One process forces a full checkpoint (load + save) while `children` writers
// write the same file: the "checkpoint under contention" case from the issue.
async function runCheckpointScenario({ children, writesPerChild, verbose }) {
  const dir = tempDir('huqan-contention-checkpoint-');
  const dbPath = path.join(dir, 'contended.graph.db');
  seedTargetFile('graph', dbPath);
  const start = process.hrtime.bigint();
  const writers = Array.from({ length: children }, (_, c) => (
    spawnChild('graph', dbPath, writesPerChild, `w${c}`, DEFAULT_BARRIER_MS)
  ));
  const checkpointer = spawnChild('graph-checkpoint', dbPath, DEFAULT_CHECKPOINT_CYCLES, 'checkpoint', DEFAULT_BARRIER_MS);
  const [procs, checkpoint] = await Promise.all([Promise.all(writers), checkpointer]);
  const wallMs = Number(process.hrtime.bigint() - start) / 1e6;

  const attempts = procs.reduce((sum, r) => sum + r.attempts, 0);
  const latencies = procs.flatMap((r) => r.latencies || []);
  const busyFailures = procs.reduce((sum, r) => sum + r.busyFailures, 0) + checkpoint.busyFailures;
  const otherFailures = procs.reduce((sum, r) => sum + r.otherFailures, 0) + checkpoint.otherFailures;

  if (verbose) {
    process.stderr.write(
      `[checkpoint] writers=${children} writes=${attempts} checkpointMs=${checkpoint.checkpointMs} `
      + `wall=${wallMs.toFixed(1)}ms busy=${busyFailures} other=${otherFailures}\n`,
    );
  }

  return {
    children,
    writesPerChild,
    checkpointCycles: DEFAULT_CHECKPOINT_CYCLES,
    totalWrites: attempts,
    wallMs: Number(wallMs.toFixed(1)),
    checkpointMs: checkpoint.checkpointMs === null ? null : Number(checkpoint.checkpointMs.toFixed(1)),
    ...summarizeLatencies(latencies),
    sqliteBusyFailures: busyFailures,
    otherFailures,
  };
}

async function main() {
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

  const results = [];
  for (const target of targets) {
    const result = await runTarget(target, { sizes, writesPerChild, verbose });
    if (target === 'graph') {
      result.checkpointUnderContention = await runCheckpointScenario({
        children: Math.max(...sizes), writesPerChild, verbose,
      });
    }
    results.push(result);
  }

  const report = { version: VERSION, generatedAt: new Date().toISOString(), sizes, writesPerChild, results };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);

  const totalFailures = results.reduce((sum, r) => {
    const perN = r.perN.reduce((s, n) => s + n.sqliteBusyFailures + n.otherFailures, 0);
    const cp = r.checkpointUnderContention
      ? r.checkpointUnderContention.sqliteBusyFailures + r.checkpointUnderContention.otherFailures
      : 0;
    return sum + perN + cp;
  }, 0);
  if (totalFailures > 0) {
    process.stderr.write(`\n${totalFailures} write(s) failed under contention.\n`);
    process.exitCode = 1;
  }
}

// Only auto-run when executed directly: the capacity envelope wrapper
// (#3503) requires this module for runTarget/summarizeLatencies, and that
// require must not start a second benchmark in the requiring process.
if (require.main === module) {
  if (process.argv.includes('--child')) childMain();
  else main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { runTarget, runOnce, runCheckpointScenario, childMain, summarizeLatencies };
