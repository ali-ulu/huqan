const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');

const TEST_FIXTURE_LEARN_BYPASS = Kernel.createAdmissionBypassOpts('test_fixture_seed');

function loadFixture(name) {
  const file = path.join(__dirname, 'fixtures', `${name}.json`);
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!Array.isArray(data)) {
    throw new Error(`Fixture must be an array: ${name}`);
  }
  return data;
}

function hrMs(start) {
  const diff = process.hrtime.bigint() - start;
  return Number(diff) / 1e6;
}

function median(values) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

const benchmarkPersistenceDirs = new Set();

process.once('exit', () => {
  for (const dir of benchmarkPersistenceDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function createKernel() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-benchmark-'));
  benchmarkPersistenceDirs.add(tempDir);
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(tempDir, 'memory.json'),
  });
  kernel.__benchmarkPersistenceDir = tempDir;
  return kernel;
}

// #3037: the shipped default is the SQLite store (graph.js resolves SQLite
// unless useSQLite is explicitly false), but the timing columns above stay
// on the stubbed store so runs stay comparable with results.json history.
// This pass learns the same statements on the default store while counting
// graph.save() calls and fs bytes, so per-learn write amplification
// regresses loudly instead of hiding behind the stub.
function createDefaultKernel() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-benchmark-default-'));
  benchmarkPersistenceDirs.add(tempDir);
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    memoryPath: path.join(tempDir, 'memory.json'),
    dbPath: path.join(tempDir, 'memory.db'),
  });
  kernel.__benchmarkPersistenceDir = tempDir;
  return kernel;
}

function benchLearnWrite(statements) {
  const kernel = createDefaultKernel();
  let saveCalls = 0;
  let bytes = 0;
  const originalSave = kernel.graph.save.bind(kernel.graph);
  kernel.graph.save = (...args) => {
    saveCalls += 1;
    return originalSave(...args);
  };
  const originalWrite = fs.writeFileSync;
  fs.writeFileSync = function (file, data, options) {
    try {
      const text = typeof data === 'string' ? data : JSON.stringify(data);
      bytes += Buffer.byteLength(text);
    } catch (_) { /* size accounting only */ }
    return originalWrite.call(fs, file, data, options);
  };
  try {
    for (const statement of statements) {
      kernel.learn(statement, TEST_FIXTURE_LEARN_BYPASS);
    }
  } finally {
    fs.writeFileSync = originalWrite;
    closeKernel(kernel);
  }
  return {
    saveCalls,
    bytes,
    bytesPerLearn: Number((bytes / statements.length).toFixed(1)),
  };
}

function closeKernel(kernel) {
  const tempDir = kernel?.__benchmarkPersistenceDir;
  try {
    if (typeof kernel?.graph?.close === 'function') kernel.graph.close();
  } finally {
    if (tempDir) {
      benchmarkPersistenceDirs.delete(tempDir);
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }
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
    medianMs: Number(median(samples).toFixed(3)),
    minMs: Number(Math.min(...samples).toFixed(3)),
    maxMs: Number(Math.max(...samples).toFixed(3)),
    result: last,
  };
}

function benchFixture(label, statements, options = {}) {
  const iterations = options.iterations ?? 5;
  const queryKernel = createKernel();

  try {
    const learn = measure(`${label}:learn`, () => {
      const learnKernel = createKernel();
      try {
        for (const statement of statements) {
          learnKernel.learn(statement, TEST_FIXTURE_LEARN_BYPASS);
        }
        return learnKernel.graph.getStats();
      } finally {
        closeKernel(learnKernel);
      }
    }, iterations);

    for (const statement of statements) {
      queryKernel.learn(statement, TEST_FIXTURE_LEARN_BYPASS);
    }

    const sample = statements[0];
    const subject = sample.split(/\s+/)[0];
    const compareLeft = statements[0].split(/\s+/)[0];
    const compareRight = statements[1]?.split(/\s+/)[0] || compareLeft;

    const ask = measure(`${label}:ask`, () => queryKernel.ask(`${subject} nedir`), iterations);
    const verify = measure(`${label}:verify`, () => queryKernel.verify(sample), iterations);
    const reason = measure(`${label}:reason`, () => queryKernel.reason(subject), iterations);
    const compare = measure(`${label}:compare`, () => queryKernel.compare(compareLeft, compareRight), iterations);
    const dream = measure(`${label}:dream`, () => queryKernel.dream(), iterations);
    const learnWrite = benchLearnWrite(statements);

    return {
      label,
      nodes: queryKernel.graph.getStats().nodes,
      edges: queryKernel.graph.getStats().edges,
      learn,
      ask,
      verify,
      reason,
      compare,
      dream,
      learnWrite,
    };
  } finally {
    closeKernel(queryKernel);
  }
}

function runBenchmarks(options = {}) {
  const fixtures = options.fixtures || ['small', 'medium', 'large', 'xlarge'];
  const iterations = options.iterations ?? 5;
  return fixtures.map(name => benchFixture(name, loadFixture(name), { iterations }));
}

function printHuman(results) {
  console.log('AXIOM benchmark results');
  for (const r of results) {
    console.log(`\n[${r.label}] ${r.nodes} nodes / ${r.edges} edges`);
    for (const key of ['learn', 'ask', 'verify', 'reason', 'compare', 'dream']) {
      const v = r[key];
      console.log(`  ${key.padEnd(7)} avg=${v.avgMs}ms median=${v.medianMs}ms min=${v.minMs}ms max=${v.maxMs}ms`);
    }
    console.log(`  learnWrite saves=${r.learnWrite.saveCalls} bytes=${r.learnWrite.bytes} bytes/learn=${r.learnWrite.bytesPerLearn} (default SQLite store)`);
  }
}

if (require.main === module) {
  const args = new Set(process.argv.slice(2));
  const iterationsArg = process.argv.find(arg => arg.startsWith('--iterations='));
  const iterations = iterationsArg ? Number(iterationsArg.split('=')[1]) : (args.has('--quick') ? 2 : 5);
  const json = args.has('--json');
  const fixturesArg = process.argv.find(arg => arg.startsWith('--fixtures='));
  const fixtures = fixturesArg ? fixturesArg.split('=')[1].split(',').filter(Boolean) : undefined;
  const results = runBenchmarks({ fixtures, iterations });
  if (json) {
    process.stdout.write(`${JSON.stringify({ iterations, results }, null, 2)}\n`);
  } else {
    printHuman(results);
  }
}

module.exports = {
  loadFixture,
  benchFixture,
  benchLearnWrite,
  runBenchmarks,
};
