'use strict';

// #3503 (R46 E3): capacity envelope measurement.
//
// Thin wrapper (~150 lines) over benchmarks/bench-sqlite-write-contention.js.
// It reuses runTarget (raw MemoryStore write contention at 1/4/16 writers)
// and summarizeLatencies (p50/p95/p99 + event-loop block), and adds the
// envelope the other benches do not cover:
//
//   - workload: real kernel.learn() through the admission gate (no bypass)
//     plus one store.query page-100 per iteration, forked into N processes;
//   - open/RSS: process.memoryUsage().rss before/after open plus a
//     bytes-per-write slope across the seed writes;
//   - WAL: the -wal/-shm sidecar bytes after the run;
//   - cold restart: warm page-100 mean vs close+reopen (open ms + cold page).
//
// Output is measurements, not a gate: the `slo` field reports the observed
// numbers, nothing here fails on a threshold. The only failure is the
// backend guard -- if better-sqlite3 is unavailable the Kernel falls back
// to JSON and the run must fail loudly instead of measuring the fallback.

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { summarizeLatencies, runTarget } = require('./bench-sqlite-write-contention');
const { isSqliteBusyError } = require('../lib/sqlite-busy-retry');

const VERSION = '1.0.0';
const DEFAULT_SIZES = [1, 4, 16];
const DEFAULT_WRITES = 20;
const MAX_CHILDREN = 16;
const BARRIER_MS = 500;
const WORKSPACE = 'capacity-envelope';

const tempDirs = new Set();
process.once('exit', () => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function parseArg(name, fallback) {
  const prefix = `--${name}=`;
  const hit = process.argv.find((arg) => arg.startsWith(prefix));
  if (!hit) return fallback;
  return hit.slice(prefix.length);
}

function parseSizes() {
  const raw = parseArg('children', null);
  if (raw === null) return DEFAULT_SIZES;
  return raw.split(',').map((s) => Math.min(MAX_CHILDREN, Math.max(1, Number(s) || 1)));
}

function tempDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.add(dir);
  return dir;
}

function barrierWait(ms) {
  if (ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function rssBytes() {
  return process.memoryUsage().rss;
}

function walSizes(dbPath) {
  const sizeOf = (p) => {
    try {
      return fs.statSync(p).size;
    } catch {
      return 0;
    }
  };
  return {
    dbBytes: sizeOf(dbPath),
    walBytes: sizeOf(`${dbPath}-wal`),
    shmBytes: sizeOf(`${dbPath}-shm`),
  };
}

function openKernel(dbPath, memoryPath) {
  const Kernel = require('../kernel');
  const kernel = new Kernel({ useSQLite: true, dbPath, memoryPath, loadPlugins: false });
  if (!kernel.graph || kernel.graph.getStats().backend !== 'sqlite') {
    throw new Error('capacity envelope requires the sqlite backend (got fallback)');
  }
  return kernel;
}

function closeKernel(kernel) {
  try {
    kernel.graph.closeSqlite();
  } catch {}
  try {
    kernel.memory.close();
  } catch {}
}

function spawnChild(dbPath, memoryPath, writes, label, barrierMs) {
  return new Promise((resolve, reject) => {
    const args = [__filename, '--child', `--db=${dbPath}`, `--memory=${memoryPath}`,
      `--writes=${writes}`, `--label=${label}`, `--barrier=${barrierMs}`];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child ${label} timed out`));
    }, 180000);
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
      } catch {
        reject(new Error(`child ${label} produced no JSON summary: ${stdout.trim()}`));
      }
    });
  });
}

function childMain() {
  const argOf = (name) => {
    const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : '';
  };
  const dbPath = argOf('db');
  const memoryPath = argOf('memory');
  const writes = Math.max(1, Number(argOf('writes')) || 1);
  const label = argOf('label');
  const barrierMs = Math.max(0, Number(argOf('barrier')) || 0);

  let kernel;
  try {
    kernel = openKernel(dbPath, memoryPath);
  } catch (error) {
    process.stderr.write(`backend guard: ${error.message}\n`);
    process.exit(2);
    return;
  }
  barrierWait(barrierMs);
  const state = { busyFailures: 0, otherFailures: 0, firstFailure: null };
  const latencies = [];
  const started = process.hrtime.bigint();
  for (let i = 0; i < writes; i += 1) {
    const t0 = process.hrtime.bigint();
    try {
      // No admission bypass: this is the real product learn path.
      const result = kernel.learn(`${label} kapasite olcumu ${i} elma meyvedir`, { workspaceId: WORKSPACE });
      if (result && result.ok === false) {
        if (isSqliteBusyError(result.error)) state.busyFailures += 1;
        else state.otherFailures += 1;
      }
      kernel.memory.query({ workspaceId: WORKSPACE, limit: 100, offset: 0 });
    } catch (error) {
      if (isSqliteBusyError(error)) state.busyFailures += 1;
      else state.otherFailures += 1;
      if (!state.firstFailure) state.firstFailure = String((error && error.message) || error);
    }
    latencies.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
  closeKernel(kernel);
  const rounded = latencies.map((ms) => Number(ms.toFixed(1)));
  process.stdout.write(`${JSON.stringify({ label, attempts: writes, ...state, elapsedMs, latencies: rounded })}\n`);
}

async function runLearnOnce(dbPath, memoryPath, children, writesPerChild, verbose) {
  const start = process.hrtime.bigint();
  const procs = await Promise.all(
    Array.from({ length: children }, (_, c) => spawnChild(dbPath, memoryPath, writesPerChild, `c${c}`, BARRIER_MS)),
  );
  const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
  const latencies = procs.flatMap((r) => r.latencies || []);
  const busyFailures = procs.reduce((sum, r) => sum + r.busyFailures, 0);
  const otherFailures = procs.reduce((sum, r) => sum + r.otherFailures, 0);
  const writePhaseMs = procs.reduce((max, r) => Math.max(max, r.elapsedMs), 0);
  if (verbose) {
    process.stderr.write(`[learn] n=${children} phase=${writePhaseMs.toFixed(1)}ms wall=${wallMs.toFixed(1)}ms busy=${busyFailures}\n`);
  }
  return {
    children,
    writesPerChild,
    totalWrites: procs.reduce((sum, r) => sum + r.attempts, 0),
    wallMs: Number(wallMs.toFixed(1)),
    writePhaseMs: Number(writePhaseMs.toFixed(1)),
    // Queue lag: parent-observed spawn/scheduling overhead above the slowest
    // child, i.e. the time writers spent waiting to run rather than writing.
    queueLagMs: Number(Math.max(0, wallMs - writePhaseMs).toFixed(1)),
    ...summarizeLatencies(latencies),
    sqliteBusyFailures: busyFailures,
    otherFailures,
  };
}

async function main() {
  const sizes = parseSizes();
  const writesPerChild = Math.max(1, Number(parseArg('writes', DEFAULT_WRITES)) || DEFAULT_WRITES);
  const verbose = process.argv.includes('--verbose');

  const dir = tempDir('huqan-capacity-envelope-');
  const dbPath = path.join(dir, 'envelope.graph.db');
  const memoryPath = path.join(dir, 'envelope.json');

  // Seed once so the schema exists before any forked writer connects, then
  // measure open/RSS on this handle.
  const rssBefore = rssBytes();
  const seedKernel = openKernel(dbPath, memoryPath);
  const rssAfterOpen = rssBytes();
  const seedStart = process.hrtime.bigint();
  for (let i = 0; i < 10; i += 1) {
    seedKernel.learn(`tohum kapasite olcumu ${i} armut meyvedir`, { workspaceId: WORKSPACE });
  }
  const seedMs = Number(process.hrtime.bigint() - seedStart) / 1e6;
  const rssAfterWrites = rssBytes();
  closeKernel(seedKernel);

  // Raw store contention baseline, reused from the contention bench.
  const contention = await runTarget('memory', { sizes, writesPerChild, verbose });

  const learnPerN = [];
  for (const n of sizes) {
    learnPerN.push(await runLearnOnce(dbPath, memoryPath, n, writesPerChild, verbose));
  }

  // Cold restart: warm page mean on a live handle vs close+reopen + cold page.
  const warmKernel = openKernel(dbPath, memoryPath);
  const warmSamples = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = process.hrtime.bigint();
    warmKernel.memory.query({ workspaceId: WORKSPACE, limit: 100, offset: 0 });
    warmSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  closeKernel(warmKernel);
  const reopenStart = process.hrtime.bigint();
  const coldKernel = openKernel(dbPath, memoryPath);
  const reopenOpenMs = Number(process.hrtime.bigint() - reopenStart) / 1e6;
  const coldStart = process.hrtime.bigint();
  coldKernel.memory.query({ workspaceId: WORKSPACE, limit: 100, offset: 0 });
  const coldQueryMs = Number(process.hrtime.bigint() - coldStart) / 1e6;
  closeKernel(coldKernel);

  const busyFailures = learnPerN.reduce((s, r) => s + r.sqliteBusyFailures + r.otherFailures, 0)
    + contention.perN.reduce((s, r) => s + r.sqliteBusyFailures + r.otherFailures, 0);
  const p99Ms = Math.max(0, ...learnPerN.map((r) => r.p99Ms || 0));
  const report = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    backend: 'sqlite',
    sizes,
    writesPerChild,
    contention,
    learn: { workload: 'kernel.learn (admission, no bypass) + store.query page-100', perN: learnPerN },
    open: {
      rss: {
        beforeBytes: rssBefore,
        afterOpenBytes: rssAfterOpen,
        afterWritesBytes: rssAfterWrites,
        slopeBytesPerWrite: Number(((rssAfterWrites - rssAfterOpen) / 10).toFixed(1)),
      },
      seedWrites: 10,
      seedMs: Number(seedMs.toFixed(1)),
    },
    wal: walSizes(dbPath),
    restart: {
      warmQueryMs: Number((warmSamples.reduce((a, b) => a + b, 0) / warmSamples.length).toFixed(2)),
      reopenOpenMs: Number(reopenOpenMs.toFixed(1)),
      coldQueryMs: Number(coldQueryMs.toFixed(2)),
    },
    // Measured, not enforced: the envelope records the SLO inputs, it never
    // fails on them. `met` is informational so a noisy runner cannot gate.
    slo: { enforced: false, zeroBusyFailures: busyFailures === 0, busyFailures, p99Ms },
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

// Same require-guard as the contention bench: requiring this module (the
// smoke test does, for parseSizes/walSizes) must not start a benchmark run.
if (require.main === module) {
  if (process.argv.includes('--child')) childMain();
  else main().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exitCode = 1;
  });
}

module.exports = { parseSizes, walSizes, DEFAULT_SIZES };
