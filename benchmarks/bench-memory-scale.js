'use strict';

const MemoryStore = require('../lib/memory-store');

const DEFAULT_SEED = 0xA10A5EED;
const DEFAULT_FIXTURES = [
  { name: 'small', size: 10 },
  { name: 'medium', size: 100 },
  { name: 'large', size: 1000 },
];
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
  const samples = [];
  let last;
  for (let i = 0; i < iterations; i++) {
    const start = process.hrtime.bigint();
    last = fn(i);
    samples.push(hrMs(start));
  }
  return {
    name,
    iterations,
    avgMs: Number(average(samples).toFixed(3)),
    last,
  };
}

function benchSize(name, size, opts) {
  const seed = (opts && opts.seed) || DEFAULT_SEED;
  const iterations = (opts && opts.iterations) || 3;
  const records = generateFixture(size, seed);

  // ingest: build a fresh in-memory store, insert all records.
  const ingest = measure(`${name}:ingest`, () => {
    const store = new MemoryStore({ useSQLite: false });
    for (const r of records) store.store(r);
    return store.list().total;
  }, iterations);

  // query: rebuild a store, then time `list()`.
  const query = measure(`${name}:query`, () => {
    const store = new MemoryStore({ useSQLite: false });
    for (const r of records) store.store(r);
    return store.list().total;
  }, iterations);

  // roundtrip: build a store, snapshot to JSON, rebuild a fresh store
  // from the JSON, and confirm record count parity. This measures the
  // memory-store JSON path end-to-end (no SQLite involved).
  const roundtrip = measure(`${name}:roundtrip`, () => {
    const store1 = new MemoryStore({ useSQLite: false });
    for (const r of records) store1.store(r);
    const snapshot = {
      memories: Array.from(store1._memories.values()).map((m) => ({
        memoryId: m.memoryId,
        workspaceId: m.workspaceId,
        content: m.content,
        createdAt: m.createdAt,
        status: m.status,
        metadata: m.metadata,
        trustPolicyVersion: m.trustPolicyVersion,
        provenance: m.provenance,
      })),
      events: store1._events,
      links: store1._links,
    };
    const json = JSON.stringify(snapshot);
    const data = JSON.parse(json);
    const store2 = new MemoryStore({ useSQLite: false });
    for (const m of data.memories) {
      store2.store({
        content: m.content,
        metadata: m.metadata,
        actor: m.provenance && m.provenance.actor,
        trustPolicyVersion: m.trustPolicyVersion,
        workspaceId: m.workspaceId,
      });
    }
    return store2.list().total;
  }, iterations);

  return {
    name,
    size,
    seed,
    iterations,
    ingestMs: ingest.avgMs,
    queryMs: query.avgMs,
    roundtripMs: roundtrip.avgMs,
    recordCount: ingest.last,
  };
}

function runBenchmarks(opts) {
  const options = opts || {};
  const fixtures = options.fixtures || DEFAULT_FIXTURES;
  return {
    version: VERSION,
    iterations: options.iterations || 3,
    seed: (options.seed !== undefined) ? options.seed : DEFAULT_SEED,
    fixtures: Object.fromEntries(
      fixtures.map((f) => [f.name, benchSize(f.name, f.size, options)])
    ),
  };
}

function printHuman(result) {
  const lines = [];
  lines.push('AXIOM memory scale benchmark');
  lines.push(`version=${result.version} seed=0x${result.seed.toString(16)} iterations=${result.iterations}`);
  for (const [, data] of Object.entries(result.fixtures)) {
    lines.push('');
    lines.push(`[${data.name}] size=${data.size} recordCount=${data.recordCount}`);
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
  makeRng,
  generateMemoryRecord,
  generateFixture,
  benchSize,
  runBenchmarks,
  printHuman,
};
