'use strict';

// #3503 (R46 E3): capacity envelope measurement.
//
// Wrapper over benchmarks/bench-sqlite-write-contention.js.
// It reuses runTarget (raw MemoryStore write contention at 1/4/16 writers)
// and summarizeLatencies (p50/p95/p99 + event-loop block), and adds the
// envelope the other benches do not cover:
//
//   - workload: real kernel.learn() through the admission gate (no bypass),
//     forked into N processes released by one parent-coordinated barrier; the
//     store is seeded with MEMORY_SEED records first, since learn() writes the
//     graph rather than kernel.memory;
//   - page vs scan: kernel.memory.list({limit:100}) against a full-workspace
//     list() over a comparable seeded dataset (SCAN_SEED records), so the
//     read leg shows the paged distribution next to the scan distribution
//     rather than only a bounded page;
//   - open/RSS: process.memoryUsage().rss before/after open plus a
//     bytes-per-write slope across the seed writes;
//   - WAL: the -wal/-shm sidecar bytes sampled while a writer connection is
//     still open (SQLite removes them on last close), with the post-close
//     sizes reported alongside for reference;
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
const WORKSPACE = 'capacity-envelope';
// The page-100 query leg needs a store that actually holds 100 records. The
// kernel's learn() writes the graph, not kernel.memory, so the store is seeded
// with this many records once before any forked writer connects.
const MEMORY_SEED = 100;
// The scan leg reads the whole workspace, so it needs a dataset large enough
// for a scan to differ from a page; SCAN_SEED > MEMORY_SEED by design.
const SCAN_SEED = 1000;
// The parent releases every child from one barrier only once all children
// have opened their kernel and signalled ready; this bounds the wait so a
// child that dies while opening cannot hang the run.
const READY_TIMEOUT_MS = 30000;
// Repeated reads per page/scan leg, so the report carries a distribution.
const READ_SAMPLES = 25;

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

function waitForRelease(releasePath) {
  if (!releasePath) return;
  // Poll for the parent's release file with a 1 ms sleep between checks: the
  // children wake within ~1 ms of each other, far tighter than a fixed
  // per-child delay measured from each child's own kernel open.
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  while (!fs.existsSync(releasePath)) Atomics.wait(sleeper, 0, 0, 1);
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

function spawnChild(dbPath, memoryPath, writes, label, releasePath, onReady) {
  return new Promise((resolve, reject) => {
    const args = [__filename, '--child', `--db=${dbPath}`, `--memory=${memoryPath}`,
      `--writes=${writes}`, `--label=${label}`, `--release=${releasePath}`];
    const child = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let ready = false;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`child ${label} timed out`));
    }, 180000);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
      // The child announces it has opened its kernel and is parked at the
      // barrier; the parent releases every child only after all are ready.
      if (!ready && stdout.includes('__READY__')) {
        ready = true;
        onReady();
      }
    });
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
      const line = stdout.trim().split('\n').filter((l) => l && !l.includes('__READY__')).pop();
      try {
        resolve(JSON.parse(line));
      } catch {
        reject(new Error(`child ${label} produced no JSON summary: ${stdout.trim()}`));
      }
    });
  });
}

function measureReads(kernel, workspaceId, samples) {
  const time = (fn) => {
    const t0 = process.hrtime.bigint();
    const result = fn();
    return { ms: Number(process.hrtime.bigint() - t0) / 1e6, result };
  };
  const pageLatencies = [];
  const scanLatencies = [];
  let pageRecords = 0;
  let scanRecords = 0;
  for (let i = 0; i < samples; i += 1) {
    const page = time(() => kernel.memory.list({ workspaceId, limit: MEMORY_SEED, offset: 0 }));
    pageLatencies.push(Number(page.ms.toFixed(3)));
    pageRecords = page.result && Array.isArray(page.result.memories) ? page.result.memories.length : 0;
    const scan = time(() => kernel.memory.list({ workspaceId }));
    scanLatencies.push(Number(scan.ms.toFixed(3)));
    scanRecords = scan.result && Array.isArray(scan.result.memories) ? scan.result.memories.length : 0;
  }
  return {
    samples,
    page: { limit: MEMORY_SEED, records: pageRecords, ...summarizeLatencies(pageLatencies) },
    scan: { records: scanRecords, ...summarizeLatencies(scanLatencies) },
    scanOverPageP50: summarizeLatencies(pageLatencies).p50Ms > 0
      ? Number((summarizeLatencies(scanLatencies).p50Ms / summarizeLatencies(pageLatencies).p50Ms).toFixed(2))
      : null,
  };
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
  const releasePath = argOf('release');

  let kernel;
  try {
    kernel = openKernel(dbPath, memoryPath);
  } catch (error) {
    process.stderr.write(`backend guard: ${error.message}\n`);
    process.exit(2);
    return;
  }
  // Announce readiness, then park until the parent releases all children
  // together. writeAt/endAt are relative to the release, so neither the
  // stagger of kernel opens nor startup leaks into the contention numbers.
  process.stdout.write('__READY__\n');
  waitForRelease(releasePath);
  const barrierEnd = process.hrtime.bigint();
  const state = { busyFailures: 0, otherFailures: 0, emptyPages: 0, firstFailure: null };
  const samples = [];
  for (let i = 0; i < writes; i += 1) {
    const t0 = process.hrtime.bigint();
    let ok = false;
    try {
      // No admission bypass: this is the real product learn path.
      const result = kernel.learn(`${label} kapasite olcumu ${i} elma meyvedir`, { workspaceId: WORKSPACE });
      if (result && result.ok === false) {
        if (isSqliteBusyError(result.error)) state.busyFailures += 1;
        else state.otherFailures += 1;
      } else {
        const page = kernel.memory.list({ workspaceId: WORKSPACE, limit: 100, offset: 0 });
        ok = !!(page && page.ok === true && Array.isArray(page.memories) && page.memories.length === MEMORY_SEED);
        if (!ok) state.emptyPages += 1;
      }
    } catch (error) {
      if (isSqliteBusyError(error)) state.busyFailures += 1;
      else state.otherFailures += 1;
      if (!state.firstFailure) state.firstFailure = String((error && error.message) || error);
    }
    const t1 = process.hrtime.bigint();
    // writeAt/endAt are relative to the barrier, so the parent can derive queue
    // lag from child-side timestamps instead of process startup and shutdown.
    samples.push({ writeAt: Number(t0 - barrierEnd) / 1e6, endAt: Number(t1 - barrierEnd) / 1e6, ok });
  }
  // Sample the WAL while this connection is still open; closing the last
  // connection checkpoints and deletes the sidecars.
  const walDuringWrites = walSizes(dbPath);
  closeKernel(kernel);
  process.stdout.write(`${JSON.stringify({ label, attempts: writes, ...state, samples, walDuringWrites })}\n`);
}

async function runLearnOnce(dbPath, memoryPath, children, writesPerChild, verbose, leg = 'learn') {
  const start = process.hrtime.bigint();
  // Parent-coordinated barrier: every child opens its kernel, announces ready,
  // then parks. The parent creates the release file only once all children are
  // ready, so all N writers start within ~1 ms of each other. A timeout keeps
  // a child that dies while opening from hanging the run.
  const dir = tempDir('huqan-capacity-barrier-');
  const releasePath = path.join(dir, 'release');
  let readyCount = 0;
  let released = false;
  let releaseTimer = null;
  const release = () => {
    if (released) return;
    released = true;
    if (releaseTimer) clearTimeout(releaseTimer);
    fs.writeFileSync(releasePath, 'go');
  };
  releaseTimer = setTimeout(release, READY_TIMEOUT_MS);
  let procs;
  try {
    procs = await Promise.all(
      Array.from({ length: children }, (_, c) => spawnChild(
        dbPath, memoryPath, writesPerChild, `c${c}`, releasePath,
        () => {
          readyCount += 1;
          if (readyCount === children) release();
        },
      )),
    );
  } finally {
    // Release any child still parked so a failure in one child cannot leave
    // the others waiting out their own timeout.
    release();
  }
  const wallMs = Number(process.hrtime.bigint() - start) / 1e6;
  // Child-side latencies, measured from just after the barrier, so startup,
  // barrier and shutdown time never enter the write or queue numbers.
  const samples = procs.flatMap((r) => r.samples || []);
  const latencies = samples.map((s) => Number((s.endAt - s.writeAt).toFixed(1)));
  const busyFailures = procs.reduce((sum, r) => sum + r.busyFailures, 0);
  const otherFailures = procs.reduce((sum, r) => sum + r.otherFailures, 0);
  const emptyPages = procs.reduce((sum, r) => sum + (r.emptyPages || 0), 0);
  const firstWriteAt = samples.length ? Math.min(...samples.map((s) => s.writeAt)) : 0;
  const lastEndAt = samples.length ? Math.max(...samples.map((s) => s.endAt)) : 0;
  const writePhaseMs = Number(Math.max(0, lastEndAt - firstWriteAt).toFixed(1));
  // queueLagMs is the part of the write phase that the longest single write
  // does not explain: with N writers released together it is real waiting for
  // the SQLite write lock, but with one writer it is just the serial work of
  // the remaining writes and must not be read as contention. Consumers should
  // read it per leg (the leg label is included) and only against N > 1.
  const longestWriteMs = latencies.length ? Math.max(...latencies) : 0;
  const queueLagMs = Number(Math.max(0, writePhaseMs - longestWriteMs).toFixed(1));
  const walDuringWrites = procs.reduce((acc, r) => {
    const w = r.walDuringWrites || {};
    return {
      dbBytes: Math.max(acc.dbBytes, w.dbBytes || 0),
      walBytes: Math.max(acc.walBytes, w.walBytes || 0),
      shmBytes: Math.max(acc.shmBytes, w.shmBytes || 0),
    };
  }, { dbBytes: 0, walBytes: 0, shmBytes: 0 });
  if (verbose) {
    process.stderr.write(`[${leg}] n=${children} phase=${writePhaseMs.toFixed(1)}ms wall=${wallMs.toFixed(1)}ms busy=${busyFailures} empty=${emptyPages}\n`);
  }
  return {
    leg,
    children,
    writesPerChild,
    totalWrites: procs.reduce((sum, r) => sum + r.attempts, 0),
    wallMs: Number(wallMs.toFixed(1)),
    writePhaseMs,
    queueLagMs,
    ...summarizeLatencies(latencies),
    sqliteBusyFailures: busyFailures,
    otherFailures,
    emptyPages,
    walDuringWrites,
  };
}

async function main() {
  const sizes = parseSizes();
  const writesPerChild = Math.max(1, Number(parseArg('writes', DEFAULT_WRITES)) || DEFAULT_WRITES);
  const verbose = process.argv.includes('--verbose');

  const dir = tempDir('huqan-capacity-envelope-');
  const dbPath = path.join(dir, 'envelope.graph.db');
  const memoryPath = path.join(dir, 'envelope.json');

  // Seed once so the schema exists before any forked writer connects, so the
  // page-100 leg reads a full page, and so the scan leg has a workspace large
  // enough for a scan to differ from a page. Both read legs read this one
  // dataset, which keeps them comparable.
  const rssBefore = rssBytes();
  const seedKernel = openKernel(dbPath, memoryPath);
  const rssAfterOpen = rssBytes();
  const seedStart = process.hrtime.bigint();
  for (let i = 0; i < SCAN_SEED; i += 1) {
    const stored = seedKernel.memory.store({ content: `tohum kapasite olcumu ${i} armut meyvedir`, workspaceId: WORKSPACE });
    if (!stored || stored.ok === false) throw new Error(`seed store failed: ${stored && stored.error ? stored.error.code : 'unknown'}`);
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
  const emptyPages = learnPerN.reduce((s, r) => s + r.emptyPages, 0);
  if (emptyPages > 0) {
    throw new Error(`page-100 query returned an empty store ${emptyPages} time(s): the seed did not persist`);
  }

  // SQL page vs scan on the seeded dataset: the same handle reads one bounded
  // page (limit 100) and the whole workspace, so the report shows both read
  // distributions side by side. The scan is asserted to return the full seed,
  // otherwise a silently truncated read would be reported as a fast scan.
  const readKernel = openKernel(dbPath, memoryPath);
  const read = measureReads(readKernel, WORKSPACE, READ_SAMPLES);
  closeKernel(readKernel);
  if (read.scan.records !== SCAN_SEED) {
    throw new Error(`scan leg read ${read.scan.records} of ${SCAN_SEED} seeded records`);
  }
  if (read.page.records !== MEMORY_SEED) {
    throw new Error(`page leg read ${read.page.records} of ${MEMORY_SEED} records`);
  }

  // Cold restart: warm page mean on a live handle vs close+reopen + cold page.
  const warmKernel = openKernel(dbPath, memoryPath);
  const warmSamples = [];
  for (let i = 0; i < 5; i += 1) {
    const t0 = process.hrtime.bigint();
    warmKernel.memory.list({ workspaceId: WORKSPACE, limit: 100, offset: 0 });
    warmSamples.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  closeKernel(warmKernel);
  const reopenStart = process.hrtime.bigint();
  const coldKernel = openKernel(dbPath, memoryPath);
  const reopenOpenMs = Number(process.hrtime.bigint() - reopenStart) / 1e6;
  const coldStart = process.hrtime.bigint();
  coldKernel.memory.list({ workspaceId: WORKSPACE, limit: 100, offset: 0 });
  const coldQueryMs = Number(process.hrtime.bigint() - coldStart) / 1e6;
  closeKernel(coldKernel);

  // Keep the two failure classes separate: a non-lock failure must never be
  // reported as SQLite busy.
  const busyFailures = learnPerN.reduce((s, r) => s + r.sqliteBusyFailures, 0)
    + contention.perN.reduce((s, r) => s + r.sqliteBusyFailures, 0);
  const otherFailures = learnPerN.reduce((s, r) => s + r.otherFailures, 0)
    + contention.perN.reduce((s, r) => s + r.otherFailures, 0);
  const walDuringWrites = learnPerN.reduce((acc, r) => ({
    dbBytes: Math.max(acc.dbBytes, r.walDuringWrites.dbBytes),
    walBytes: Math.max(acc.walBytes, r.walDuringWrites.walBytes),
    shmBytes: Math.max(acc.shmBytes, r.walDuringWrites.shmBytes),
  }), { dbBytes: 0, walBytes: 0, shmBytes: 0 });
  // The post-close sizes are reported for reference; SQLite checkpoints and
  // removes the sidecars when the last connection closes, so they are usually
  // zero and are not the contention measurement.
  const walAfterClose = walSizes(dbPath);
  const p99Ms = Math.max(0, ...learnPerN.map((r) => r.p99Ms || 0));
  const report = {
    version: VERSION,
    generatedAt: new Date().toISOString(),
    backend: 'sqlite',
    sizes,
    writesPerChild,
    contention,
    read,
    learn: { workload: 'kernel.learn (admission, no bypass)', perN: learnPerN },
    open: {
      rss: {
        beforeBytes: rssBefore,
        afterOpenBytes: rssAfterOpen,
        afterWritesBytes: rssAfterWrites,
        slopeBytesPerWrite: Number(((rssAfterWrites - rssAfterOpen) / SCAN_SEED).toFixed(1)),
      },
      seedWrites: SCAN_SEED,
      seedMs: Number(seedMs.toFixed(1)),
    },
    wal: { ...walDuringWrites, afterClose: walAfterClose },
    restart: {
      warmQueryMs: Number((warmSamples.reduce((a, b) => a + b, 0) / warmSamples.length).toFixed(2)),
      reopenOpenMs: Number(reopenOpenMs.toFixed(1)),
      coldQueryMs: Number(coldQueryMs.toFixed(2)),
    },
    // Measured, not enforced: the envelope records the SLO inputs, it never
    // fails on them. `met` is informational so a noisy runner cannot gate.
    // queueLagMs is only meaningful as contention for the N > 1 learn legs;
    // the N = 1 leg carries it as serial-work context, not as a queue.
    slo: { enforced: false, zeroBusyFailures: busyFailures === 0, busyFailures, otherFailures, p99Ms },
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
