'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { summarizeLatencies } = require('./bench-sqlite-write-contention');

function validate({ nodes, writes }) {
  if (!Number.isSafeInteger(nodes) || nodes < 1 || nodes > 100000
    || !Number.isSafeInteger(writes) || writes < 1 || writes > 1000) {
    throw new Error('ARGUMENT: nodes=1..100000, writes=1..1000 required');
  }
  return { nodes, writes };
}

function parseArgs(args) {
  const options = { nodes: 10000, writes: 100 }, seen = new Set();
  for (const arg of args) {
    const match = /^--(nodes|writes)=(\d+)$/u.exec(arg);
    if (!match || seen.has(match[1])) throw new Error('ARGUMENT: unknown or duplicate option');
    seen.add(match[1]);
    options[match[1]] = Number(match[2]);
  }
  return validate(options);
}

// Own temp fixture only; seed writes are NOT admitted-learning throughput.
// No policy, maintenance frequency, export cadence or gate is overridden.
async function runSeries(options) {
  const { nodes, writes } = validate(options);
  const Kernel = require('../kernel');
  const tempRoot = fs.realpathSync.native(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(tempRoot, 'huqan-admitted-series-'));
  // autoMaintain calls selfEvolve() with its default workspace. Put the
  // workload there too, so its real data participates in scheduled upkeep.
  const workspaceId = 'default';
  const opts = { useSQLite: true, loadPlugins: false,
    dbPath: path.join(directory, 'graph.db'), memoryPath: path.join(directory, 'memory.json') };
  let kernel;
  const close = () => {
    if (kernel) { kernel.graph.closeSqlite(); kernel.memory.close(); kernel = null; }
  };
  try {
    const openStart = performance.now();
    kernel = new Kernel(opts);
    const openMs = performance.now() - openStart;
    assert.equal(kernel.graph.getStats().backend, 'sqlite', 'SQLite backend required');
    const seedStart = performance.now();
    kernel.graph.runMutationOnce('admitted-series-seed', () => {
      for (let i = 0; i < nodes; i++) kernel.graph.addNode(`seed-${i}`, `seed-${i}`, null, { workspaceId });
      return { nodes };
    });
    const seedMs = performance.now() - seedStart;
    close();
    const trialOpenStart = performance.now();
    kernel = new Kernel(opts);
    const trialOpenMs = performance.now() - trialOpenStart;
    assert.equal(kernel.graph.nodeCount(workspaceId), nodes);
    assert.equal(kernel.graph.edgeCount(workspaceId), 0);
    const maintenance = { every: kernel.maintenanceEvery, calls: 0, errors: 0, ms: 0 };
    const exportMirror = { calls: 0, errors: 0, ms: 0 };
    const receipts = { computed: 0, upper_bound: 0, other: 0, reasons: {} };
    let getNodesCalls = 0;
    const getNodes = kernel.graph.getNodes;
    kernel.graph.getNodes = function (...args) { getNodesCalls++; return getNodes.apply(this, args); };
    const save = kernel.graph.save;
    kernel.graph.save = function (...args) {
      const start = performance.now(); exportMirror.calls++;
      try { return save.apply(this, args); }
      catch (error) { exportMirror.errors++; throw error; }
      finally { exportMirror.ms += performance.now() - start; }
    };
    const evolve = kernel.selfEvolve;
    kernel.selfEvolve = function (...args) {
      const start = performance.now(); maintenance.calls++;
      try { return evolve.apply(this, args); }
      catch (error) { maintenance.errors++; throw error; }
      finally { maintenance.ms += performance.now() - start; }
    };
    const latencies = [], start = performance.now();
    for (let i = 0; i < writes; i++) {
      const before = performance.now();
      const result = kernel.learn(`profil-${i} meyvedir`, {
        workspaceId, approvalRequired: true, approvalStatus: 'approved', approvalId: `apr_series_${i}`,
        provenance: { provenanceId: `prov_series_${i}`, sourceType: 'manual', sourceRef: 'test:admitted-series',
          actor: 'kernel-test', workspaceId, timestamp: new Date().toISOString(), trustPolicyVersion: '1.0.0' },
      });
      latencies.push(performance.now() - before);
      assert.equal(result.ok, true);
      assert.equal(result.data.admission.outcome, 'allow');
      assert.equal(result.data.learned, 1);
      const radius = result.data.admission.receipt.metadata.justification.blastRadius;
      receipts[Object.hasOwn(receipts, radius.status) && radius.status !== 'reasons' ? radius.status : 'other']++;
      if (radius.status !== 'computed') {
        const reason = JSON.stringify(radius);
        receipts.reasons[reason] = (receipts.reasons[reason] || 0) + 1;
      }
      // Drain the actual default maintenance scheduled by this write.
      await new Promise(setImmediate);
    }
    const seriesMs = performance.now() - start;
    assert.equal(maintenance.errors, 0, 'maintenance errors invalidate the run');
    assert.equal(exportMirror.errors, 0, 'mirror errors invalidate the run');
    assert.equal(maintenance.calls, Math.floor(writes / maintenance.every));
    close();
    const reopenStart = performance.now();
    kernel = new Kernel(opts);
    const reopenMs = performance.now() - reopenStart;
    assert.equal(kernel.graph.getStats().backend, 'sqlite');
    assert.equal(kernel.graph.nodeCount(workspaceId), nodes + writes + 1);
    for (let i = 0; i < writes; i++) {
      const edges = kernel.graph.getEdges(`profil-${i}`, workspaceId);
      assert.equal(edges.length, 1);
      assert.equal(edges[0].to, 'meyve');
      assert.equal(edges[0].relation, 'tür');
    }
    return { backend: 'sqlite', workspaceId, seedNodes: nodes, seedEdges: 0, writes, openMs, seedMs, trialOpenMs,
      seriesMs, writesPerSecond: writes * 1000 / seriesMs, cold: { count: 1, ms: latencies[0] },
      warm: { count: latencies.length - 1, ...summarizeLatencies(latencies.slice(1)) },
      maintenance, exportMirror, receipts, getNodesCalls, reopenMs, reopenedEdges: writes,
      runtime: { node: process.version, platform: process.platform, arch: process.arch,
        sqlite: require('better-sqlite3/package.json').version },
      limits: 'Sequential approved fixture, nodes-only seed; same-process SQLite reopen; no production or concurrent-write guarantee.' };
  } finally {
    close();
    assert.equal(path.dirname(fs.realpathSync.native(directory)), tempRoot);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

if (require.main === module) {
  Promise.resolve().then(() => runSeries(parseArgs(process.argv.slice(2))))
    .then(result => console.log(JSON.stringify(result)))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
module.exports = { runSeries, parseArgs };
