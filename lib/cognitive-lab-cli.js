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
const { replayBaseline } = require('./cognitive-lab-b1-replay');
const { runB6Experiment } = require('./cognitive-lab-b6-experiment');
const { runB4Experiment } = require('./cognitive-lab-b4-experiment');
const { runContradictionBaseline } = require('./cognitive-lab-contradiction-evaluator');

const STATE_SCHEMA = 'huqan-cognitive-lab-state-v1';
const STATE_PREFIX = 'huqan-cognitive-lab-';
const REPLAY_SCRATCH_PREFIX = 'huqan-cognitive-lab-b1-replay-';
const MARKER = 'comparison-state.json';
const MAX_INPUT_BYTES = 1024 * 1024;
// Store-free measurement sub-paths: the command name maps to its required flag.
// A new mechanism adds a table entry, not another branch.
const RECORD_COMMANDS = Object.freeze({ b4: '--b4-records', b6: '--b6-records', contradiction: '--contradiction-records' });
const HELP = Object.freeze({
  usage: ['huqan-cognitive-lab init [--root DIR] < manifest.json',
    'huqan-cognitive-lab forecast|outcome|budget|report --state DIR < input.json',
    'huqan-cognitive-lab replay --replay-manifest FILE',
    'huqan-cognitive-lab b4 --b4-records FILE',
    'huqan-cognitive-lab b6 --b6-records FILE',
    'huqan-cognitive-lab contradiction --contradiction-records FILE'],
  commands: {
    init: 'Deney sözleşmesini yeni, izole SQLite klasöründe kilitler.',
    forecast: '{runId,variant,taskId,probability}: sonuçtan önce açık olasılık.',
    outcome: '{runId,taskId,outcome}: iki varyantın ortak gözlenen sonucu.',
    budget: '{runId,variant,envelope,usage}: çağıranın bildirdiği kullanım; varyantı mühürler.',
    report: '{runId}: eşlenmiş Brier/ECE; genel öğrenme kazanımı NOT_MEASURED.',
    replay: 'Donmuş B1 manifestini izole temp store üzerinde replay eder; kalıcı store açmaz, kanonik belleğe dokunmaz.',
    b4: 'Donmuş B4 prosedür-transfer kayıtlarını değerlendirir; mechanisms.B4=ENABLED manifesti üretir, store açmaz.',
    b6: 'Donmuş B6 eşit-bütçe ablation kayıtlarını değerlendirir; mechanisms.B6=ENABLED manifesti üretir, store açmaz.',
    contradiction: 'Donmuş R50 contradiction corpus+labels üzerinde A (declared heuristic) / B (calibrated) kollarını ölçer; store açmaz.',
  },
  inputLimitBytes: MAX_INPUT_BYTES,
});

function options(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) return { help: true };
  const [command, flag, value, ...extra] = args;
  if (!['init', 'forecast', 'outcome', 'budget', 'report', 'replay', ...Object.keys(RECORD_COMMANDS)].includes(command)) throw new TypeError('unknown command');
  if (command === 'replay') {
    if (flag !== '--replay-manifest' || !value || extra.length) throw new TypeError('expected replay --replay-manifest FILE');
    return { command, manifestPath: value };
  }
  if (RECORD_COMMANDS[command]) {
    const expected = RECORD_COMMANDS[command];
    if (flag !== expected || !value || extra.length) throw new TypeError(`expected ${command} ${expected} FILE`);
    return { command, recordsPath: value };
  }
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

/**
 * Read the replay request file before any store exists. A missing, oversized
 * or non-object file fails here, so a corrupt request never reaches the
 * runner and no Graph -- temp or otherwise -- is opened for it.
 */
function readReplayRequest(manifestPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(manifestPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new TypeError('replay manifest file does not exist');
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_INPUT_BYTES) {
      throw new TypeError('replay manifest must be a bounded regular file');
    }
    // Validate and read the same inode, even if its pathname is replaced.
    // A single readSync may return short, so read until EOF or one byte past
    // the limit -- that extra byte proves the file outgrew the bound.
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = fs.readSync(descriptor, buffer, size, buffer.length - size, size);
      if (read === 0) break;
      size += read;
    }
    if (size > MAX_INPUT_BYTES) throw new TypeError('replay manifest must be a bounded regular file');
    const request = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('replay manifest JSON object required');
    return request;
  } finally { fs.closeSync(descriptor); }
}

/**
 * Opt-in B1 baseline replay (#3501). The frozen `{manifest, manifestDigest,
 * experiment}` request is replayed through the pure `replayBaseline` runner
 * against a private temp store that is removed afterwards. Canonical memory
 * is never opened on this path: the only Graph the runner sees lives under
 * the scratch directory. An invalid manifest is reported by the runner as a
 * REJECT result; a missing or unreadable request file throws before any
 * store is created.
 */
function runB1Replay(manifestPath, { openGraph } = {}) {
  if (typeof openGraph !== 'function') throw new TypeError('replay requires a graph opener');
  const request = readReplayRequest(manifestPath);
  const parent = fs.realpathSync(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(parent, REPLAY_SCRATCH_PREFIX));
  if (path.dirname(scratch) !== parent || !path.basename(scratch).startsWith(REPLAY_SCRATCH_PREFIX)) throw new Error('invalid temporary replay path');
  fs.chmodSync(scratch, 0o700);
  let graph;
  try {
    graph = openGraph({ memoryPath: path.join(scratch, 'memory.json'), dbPath: path.join(scratch, 'memory.db') });
    // Mode stays the production baseline. The leak-injecting modes exist only
    // as direct `replayBaseline` test arguments, never as a CLI surface.
    return replayBaseline(graph,
      { manifest: request.manifest, manifestDigest: request.manifestDigest, experiment: request.experiment },
      { ruleId: request.ruleId, declaredConfidence: request.declaredConfidence, mode: 'baseline' });
  } finally {
    try { if (graph && typeof graph.closeSqlite === 'function') graph.closeSqlite(); }
    finally { fs.rmSync(scratch, { recursive: true, force: true }); }
  }
}

/**
 * Opt-in B4 learned-procedure-transfer measurement (#3562). The frozen
 * `{records, corpusDigest, sourceCommit, sourceDirty, seed, tasks,
 * trainContents}` request is scored by the pure `runB4Experiment` runner and
 * the resulting candidate-only manifest is returned. No store is opened on this
 * path: the evaluator is a pure function over the supplied records, so canonical
 * memory is untouched. A malformed request file throws before the runner is
 * reached.
 */
function runB4Measurement(recordsPath) {
  const request = readReplayRequest(recordsPath);
  return runB4Experiment({
    records: request.records,
    corpusDigest: request.corpusDigest,
    sourceCommit: request.sourceCommit,
    sourceDirty: request.sourceDirty,
    seed: request.seed,
    trainIds: request.trainIds,
    tasks: request.tasks,
    trainContents: request.trainContents,
  });
}

/**
 * Opt-in B6 equal-budget ablation measurement (#3562). The frozen
 * `{records, corpusDigest, sourceCommit, sourceDirty, seed}` request is scored
 * by the pure `runB6Experiment` runner and the resulting candidate-only
 * manifest is returned. No store is opened on this path: the evaluator is a
 * pure function over the supplied records, so canonical memory is untouched. A
 * malformed request file throws before the runner is reached.
 */
function runB6Measurement(recordsPath) {
  const request = readReplayRequest(recordsPath);
  return runB6Experiment({
    records: request.records,
    corpusDigest: request.corpusDigest,
    sourceCommit: request.sourceCommit,
    sourceDirty: request.sourceDirty,
    seed: request.seed,
  });
}

/**
 * Opt-in R50 contradiction A/B measurement (#3582). The frozen
 * `{corpus, labels, contract, threshold?}` request is scored by the pure
 * `runContradictionBaseline` runner: it fits the calibration mapping on the
 * calibration split only and reports arm A (declared heuristic) and arm B
 * (calibrated) on the frozen holdout. No store is opened on this path, so
 * canonical memory is untouched. A malformed request file throws before the
 * runner is reached.
 */
function runContradictionMeasurement(recordsPath) {
  const request = readReplayRequest(recordsPath);
  return runContradictionBaseline({
    corpus: request.corpus,
    labels: request.labels,
    contract: request.contract,
    threshold: request.threshold,
  });
}

async function runCognitiveLab(args, { openGraph, readDesign, stdin = process.stdin } = {}) {
  const opts = options(args);
  if (opts.help) return HELP;
  // The replay sub-path is opt-in: only an explicit `replay --replay-manifest`
  // invocation reaches the B1 runner. Every other command keeps its existing
  // behaviour and never replays.
  if (opts.command === 'replay') return runB1Replay(opts.manifestPath, { openGraph });
  // The B4/B6 sub-paths are opt-in and store-free: only `b4 --b4-records` or
  // `b6 --b6-records` reaches their measurement, and neither opens a graph.
  if (opts.command === 'b4') return runB4Measurement(opts.recordsPath);
  if (opts.command === 'b6') return runB6Measurement(opts.recordsPath);
  if (opts.command === 'contradiction') return runContradictionMeasurement(opts.recordsPath);
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
