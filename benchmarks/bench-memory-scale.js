'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const MemoryStore = require('../lib/memory-store');

const DEFAULT_SEED = 0xA10A5EED;
const DEFAULT_FIXTURES = [
  { name: 'small', size: 10 },
  { name: 'medium', size: 100 },
  { name: 'large', size: 1000 },
];
const DEFAULT_SQLITE_FIXTURES = DEFAULT_FIXTURES.map((fixture) => ({ ...fixture }));
const WARMUP_ITERATIONS = 2;
const VERSION = '1.0.0';

// Deterministic PRNG (mulberry32). Same seed -> same sequence.
function makeRng(seed) {
  let s = seed >>> 0;
  return function next() {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateMemoryRecord(i, rng, workspaceId) {
  const idx = (i * 2654435761) >>> 0; // Knuth multiplicative hash
  const tag = rng() < 0.5 ? 'A' : 'B';
  const actor = rng() < 0.5 ? 'alice' : 'bob';
  const priority = Math.floor(rng() * 5);
  return {
    content: `mem-${idx.toString(16).padStart(8, '0')}-${Math.floor(rng() * 1e6)}`,
    metadata: { tag, priority },
    actor,
    trustPolicyVersion: '1.0.0',
    workspaceId,
  };
}

function generateFixture(size, seed, workspaceId) {
  const rng = makeRng(seed);
  const wid = workspaceId || 'default';
  return Array.from({ length: size }, (_, i) => generateMemoryRecord(i, rng, wid));
}

function hrMs(start) {
  return Number(process.hrtime.bigint() - start) / 1e6;
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function measure(name, fn, iterations) {
  // Warmup calls are deliberately outside the returned samples. The first
  // invocation can include V8/JIT setup and must not distort the metric.
  for (let i = 0; i < WARMUP_ITERATIONS; i++) fn(i, 'warmup');

  const samples = [];
  let last;
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    last = fn(i, 'measured');
    samples.push(hrMs(start));
  }
  return {
    name,
    iterations,
    warmupIterations: WARMUP_ITERATIONS,
    avgMs: Number(average(samples).toFixed(3)),
    last,
  };
}

function createStore(useSQLite, dbPath) {
  if (useSQLite) return new MemoryStore({ useSQLite: true, dbPath });
  return new MemoryStore({ useSQLite: false });
}

function populateStore(store, records) {
  for (const record of records) store.store(record);
  return store;
}

function closeStore(store) {
  if (store) store.close();
}

function snapshotStore(store) {
  return {
    memories: Array.from(store._memories.values()).map((m) => ({
      memoryId: m.memoryId,
      workspaceId: m.workspaceId,
      content: m.content,
      createdAt: m.createdAt,
      status: m.status,
      metadata: m.metadata,
      trustPolicyVersion: m.trustPolicyVersion,
      provenance: m.provenance,
    })),
    events: store._events,
    links: store._links,
  };
}

function benchSize(name, size, opts) {
  const options = opts || {};
  const seed = options.seed || DEFAULT_SEED;
  const iterations = options.iterations || 3;
  const useSQLite = options.useSQLite === true;
  const records = generateFixture(size, seed);
  const tempRoot = useSQLite
    ? fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-bench-memory-'))
    : null;
  const dbPathFor = (phase, sampleType, iteration) => (
    tempRoot ? path.join(tempRoot, `${name}-${phase}-${sampleType}-${iteration}.db`) : undefined
  );
  const makeStore = (phase, sampleType, iteration) => (
    createStore(useSQLite, dbPathFor(phase, sampleType, iteration))
  );

  let queryStore;
  try {
    // ingest: build a fresh store and insert all records. The count is read
    // from the store-owned collection so ingestion timing contains no query.
    const ingest = measure(`${name}:ingest`, (iteration, sampleType) => {
      const store = makeStore('ingest', sampleType, iteration);
      try {
        populateStore(store, records);
        return store._memories.size;
      } finally {
        closeStore(store);
      }
    }, iterations);

    // query: build the fixture once, outside the timed function. The measured
    // body is only list(), so queryMs cannot include fixture construction.
    queryStore = makeStore('query', 'fixture', 0);
    populateStore(queryStore, records);
    const query = measure(`${name}:query`, () => queryStore.list().total, iterations);

    // roundtrip: build a store, snapshot to JSON, rebuild a fresh store from
    // the JSON, and confirm record count parity. This measures the selected
    // backend's persistence path end-to-end.
    const roundtrip = measure(`${name}:roundtrip`, (iteration, sampleType) => {
      let store1;
      let store2;
      try {
        store1 = makeStore('roundtrip-source', sampleType, iteration);
        populateStore(store1, records);
        const json = JSON.stringify(snapshotStore(store1));
        const data = JSON.parse(json);
        store2 = makeStore('roundtrip-target', sampleType, iteration);
        for (const memory of data.memories) {
          store2.store({
            content: memory.content,
            metadata: memory.metadata,
            actor: memory.provenance && memory.provenance.actor,
            trustPolicyVersion: memory.trustPolicyVersion,
            workspaceId: memory.workspaceId,
          });
        }
        return store2._memories.size;
      } finally {
        closeStore(store2);
        closeStore(store1);
      }
    }, iterations);

    return {
      name,
      size,
      seed,
      iterations,
      warmupIterations: WARMUP_ITERATIONS,
      useSQLite,
      ingestMs: ingest.avgMs,
      queryMs: query.avgMs,
      roundtripMs: roundtrip.avgMs,
      recordCount: ingest.last,
    };
  } finally {
    closeStore(queryStore);
    if (tempRoot) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

function runBenchmarks(opts) {
  const options = opts || {};
  const fixtures = options.fixtures || DEFAULT_FIXTURES;
  const sqliteFixtures = options.sqliteFixtures || DEFAULT_SQLITE_FIXTURES;
  return {
    version: VERSION,
    iterations: options.iterations || 3,
    warmupIterations: WARMUP_ITERATIONS,
    seed: (options.seed !== undefined) ? options.seed : DEFAULT_SEED,
    fixtures: Object.fromEntries(
      fixtures.map((f) => [f.name, benchSize(f.name, f.size, { ...options, useSQLite: false })])
    ),
    sqliteFixtures: Object.fromEntries(
      sqliteFixtures.map((f) => [f.name, benchSize(f.name, f.size, { ...options, useSQLite: true })])
    ),
  };
}

function printHuman(result) {
  const lines = [];
  lines.push('AXIOM memory scale benchmark');
  lines.push(`version=${result.version} seed=0x${result.seed.toString(16)} iterations=${result.iterations} warmupIterations=${result.warmupIterations}`);
  for (const [, data] of Object.entries(result.fixtures)) {
    lines.push('');
    lines.push(`[memory:${data.name}] size=${data.size} recordCount=${data.recordCount}`);
    lines.push(`  ingest    avg=${data.ingestMs}ms`);
    lines.push(`  query     avg=${data.queryMs}ms`);
    lines.push(`  roundtrip avg=${data.roundtripMs}ms`);
  }
  for (const [, data] of Object.entries(result.sqliteFixtures || {})) {
    lines.push('');
    lines.push(`[sqlite:${data.name}] size=${data.size} recordCount=${data.recordCount}`);
    lines.push(`  ingest    avg=${data.ingestMs}ms`);
    lines.push(`  query     avg=${data.queryMs}ms`);
    lines.push(`  roundtrip avg=${data.roundtripMs}ms`);
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const json = args.includes('--json');
  const iterationsArg = args.find((a) => a.startsWith('--iterations='));
  const iterations = iterationsArg ? Number(iterationsArg.split('=')[1]) : 3;
  const seedArg = args.find((a) => a.startsWith('--seed='));
  const seed = seedArg ? Number(seedArg.split('=')[1]) : DEFAULT_SEED;
  const sizesArg = args.find((a) => a.startsWith('--sizes='));
  const fixtures = sizesArg
    ? sizesArg
        .split('=')[1]
        .split(',')
        .filter(Boolean)
        .map((s) => {
          const [name, size] = s.split(':');
          return { name, size: Number(size) };
        })
    : DEFAULT_FIXTURES;
  const result = runBenchmarks({ iterations, seed, fixtures });
  if (json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printHuman(result);
  }
}

module.exports = {
  VERSION,
  DEFAULT_SEED,
  DEFAULT_FIXTURES,
  DEFAULT_SQLITE_FIXTURES,
  WARMUP_ITERATIONS,
  makeRng,
  generateMemoryRecord,
  generateFixture,
  benchSize,
  runBenchmarks,
  printHuman,
};
