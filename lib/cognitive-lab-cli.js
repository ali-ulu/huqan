'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const lockfile = require('proper-lockfile');
const { buildComparisonManifest } = require('./cognitive-lab-comparison-contract');
const {
  prepareComparison, readComparisonDesign, recordComparisonForecast,
  recordComparisonOutcome, recordComparisonBudget, reportComparison,
} = require('./cognitive-lab-comparison-store');

const STATE_SCHEMA = 'huqan-cognitive-lab-state-v1';
const STATE_PREFIX = 'huqan-cognitive-lab-';
const MARKER = 'comparison-state.json';
const MAX_INPUT_BYTES = 1024 * 1024;
const HELP = Object.freeze({
  usage: ['huqan-cognitive-lab init [--root DIR] < manifest.json',
    'huqan-cognitive-lab forecast|outcome|budget|report --state DIR < input.json'],
  commands: {
    init: 'Deney sözleşmesini yeni, izole SQLite klasöründe kilitler.',
    forecast: '{runId,variant,taskId,probability}: sonuçtan önce açık olasılık.',
    outcome: '{runId,taskId,outcome}: iki varyantın ortak gözlenen sonucu.',
    budget: '{runId,variant,envelope,usage}: çağıranın bildirdiği kullanım; varyantı mühürler.',
    report: '{runId}: eşlenmiş Brier/ECE; genel öğrenme kazanımı NOT_MEASURED.',
  },
  inputLimitBytes: MAX_INPUT_BYTES,
});

function options(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) return { help: true };
  const [command, flag, value, ...extra] = args;
  if (!['init', 'forecast', 'outcome', 'budget', 'report'].includes(command)) throw new TypeError('unknown command');
  const expected = command === 'init' ? '--root' : '--state';
  if (command === 'init' && args.length === 1) return { command, root: os.tmpdir() };
  if (flag !== expected || !value || extra.length) throw new TypeError(`expected ${command} ${expected} DIR`);
  return { command, [command === 'init' ? 'root' : 'state']: value };
}

async function readInput(stdin) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > MAX_INPUT_BYTES) throw new TypeError('input exceeds bounded JSON size');
    chunks.push(bytes);
  }
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('JSON object required');
  return input;
}

function inspectState(input) {
  const state = path.resolve(input);
  if (!path.basename(state).startsWith(STATE_PREFIX) || fs.lstatSync(state).isSymbolicLink()
    || fs.realpathSync(state) !== state) throw new TypeError('unowned or linked comparison state');
  for (const name of fs.readdirSync(state)) {
    const stat = fs.lstatSync(path.join(state, name));
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new TypeError('linked or non-file state entry');
  }
  const markerPath = path.join(state, MARKER);
  const descriptor = fs.openSync(markerPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  let marker;
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4096) throw new TypeError('invalid state marker');
    // Validate and read the same inode, even if its pathname is replaced.
    // Read one byte past the limit to reject growth without an unbounded read.
    const buffer = Buffer.alloc(4097);
    const size = fs.readSync(descriptor, buffer, 0, buffer.length, 0);
    if (size > 4096) throw new TypeError('invalid state marker');
    marker = JSON.parse(buffer.subarray(0, size).toString('utf8'));
  } finally { fs.closeSync(descriptor); }
  if (marker.schemaVersion !== STATE_SCHEMA || typeof marker.runId !== 'string'
    || typeof marker.designDigest !== 'string' || !/^[a-f0-9]{64}$/.test(marker.designDigest)
    || Object.keys(marker).sort().join(',') !== 'designDigest,runId,schemaVersion') throw new TypeError('invalid state marker');
  return { state, marker };
}

function newState(root, design) {
  const parent = fs.realpathSync(root);
  if (!fs.statSync(parent).isDirectory()) throw new TypeError('existing state root directory required');
  const state = fs.mkdtempSync(path.join(parent, STATE_PREFIX));
  fs.chmodSync(state, 0o700);
  const marker = { schemaVersion: STATE_SCHEMA, runId: design.manifest.runId, designDigest: design.digest };
  fs.writeFileSync(path.join(state, MARKER), JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
  return { state, marker };
}

async function runCognitiveLab(args, { openGraph, readDesign, stdin = process.stdin } = {}) {
  const opts = options(args);
  if (opts.help) return HELP;
  const input = await readInput(stdin);
  const owned = opts.command === 'init'
    ? newState(opts.root, buildComparisonManifest(input)) : inspectState(opts.state);
  const started = performance.now();
  const release = lockfile.lockSync(owned.state, { realpath: true, retries: 0, stale: 300000, update: 10000 });
  let graph;
  try {
    // Recheck after acquiring the lock. The explicit private paths are the only
    // paths given to the injected composition root; global memory is not used.
    inspectState(owned.state);
    const paths = { memoryPath: path.join(owned.state, 'memory.json'), dbPath: path.join(owned.state, 'memory.db') };
    if (opts.command !== 'init') {
      if (input.runId !== owned.marker.runId) throw new Error('state and frozen experiment identity differ');
      if (!fs.existsSync(paths.dbPath)) throw new Error('comparison database does not exist');
      // A writable Graph may create/migrate schema even before a mutation.
      // Authenticate its frozen contract with a read-only handle first.
      if (readDesign(paths.dbPath, input.runId).digest !== owned.marker.designDigest) throw new Error('state and frozen experiment identity differ');
    }
    graph = openGraph(paths);
    if (!graph._db) throw new Error('native SQLite backend is required; JSON fallback is not admitted');
    let result;
    if (opts.command === 'init') result = prepareComparison(graph, input);
    else {
      if (input.runId !== owned.marker.runId || readComparisonDesign(graph, input.runId).digest !== owned.marker.designDigest) {
        throw new Error('state and frozen experiment identity differ');
      }
      const operations = { forecast: recordComparisonForecast, outcome: recordComparisonOutcome, budget: recordComparisonBudget, report: reportComparison };
      result = operations[opts.command](graph, input);
    }
    return {
      ...result, state: owned.state,
      runtime: { backend: 'sqlite', nodeVersion: process.version, packageVersion: require('../package.json').version,
        commandWallTimeMs: performance.now() - started, sourceEvidence: 'CALLER_DECLARED', budgetUsageEvidence: 'CALLER_REPORTED' },
    };
  } finally {
    try { if (graph) graph.closeSqlite(); }
    finally { release(); }
  }
}

module.exports = { runCognitiveLab };
