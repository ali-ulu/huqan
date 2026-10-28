'use strict';
// #4065 G1 measurement runner (preregistration
// docs/task-packs/cog-m7-g1-holdout-preregistration-20261027.md, v3 §12).
// calibrate: frozen train history, 8 calibration groups x 3 seeds x 2 arms,
//   anti-cases and the observation-cut mutation, then sigma and N locked in
//   the manifest. holdout: runs once against a locked manifest.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const corpusApi = require('./cognitive-lab-g1-corpus');
const stats = require('./cognitive-lab-g1-stats');

const MANIFEST_SCHEMA = 'huqan-g1-manifest-v1';
const SEEDS = Object.freeze([1, 2, 3]);
// v3 §12: the plan holds all four approved tasks; two of them execute.
const BUDGET = Object.freeze({ maxSteps: 4, maxIterations: 2, maxEpisodeSteps: 6 });
const MIN_STRATUM_GROUPS = 8;
const PRELOAD = path.join(__dirname, 'cognitive-lab-g1-arm-preload.js');
const CHILD = path.join(__dirname, 'cognitive-lab-g1-episode.js');
const CHILD_TIMEOUT_MS = 30 * 60 * 1000;
const PREREGISTRATION = path.join(__dirname, '..', 'docs', 'task-packs', 'cog-m7-g1-holdout-preregistration-20261027.md');

// Line endings follow the checkout (core.autocrlf); the digest pins content.
const fileDigest = file => corpusApi.sha256(fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n'));
// Read directly and treat only ENOENT as absent: no check-then-read race.
function readOrNull(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
const readJsonOrNull = file => { const text = readOrNull(file); return text === null ? null : JSON.parse(text); };
const readJsonl = file => (readOrNull(file) ?? '').split('\n').filter(Boolean).map(line => JSON.parse(line));

// One fixed, read-only source repository: the cognition frame binds its path
// and HEAD, so history and every episode must point at the same one.
function prepareSource(baseDir) {
  const source = path.join(baseDir, 'source');
  if (fs.existsSync(path.join(source, '.git'))) return source;
  fs.mkdirSync(source, { recursive: true });
  const env = { ...process.env, GIT_AUTHOR_DATE: '2026-10-27T00:00:00Z', GIT_COMMITTER_DATE: '2026-10-27T00:00:00Z' };
  const git = (...args) => execFileSync('git', args, { cwd: source, env, encoding: 'utf8', windowsHide: true, stdio: 'pipe' });
  git('init', '-b', 'feature/g1'); git('config', 'commit.gpgsign', 'false'); git('config', 'core.autocrlf', 'false');
  fs.writeFileSync(path.join(source, 'seed.txt'), 'g1 synthetic control source\n'); git('add', 'seed.txt');
  git('-c', 'user.name=G1 Runner', '-c', 'user.email=g1@example.invalid', 'commit', '-m', 'g1 source');
  return source;
}

const gitIn = (source, ...args) => execFileSync('git', args, { cwd: source, encoding: 'utf8', windowsHide: true, stdio: 'pipe' }).trim();
const sourceState = source => ({ head: gitIn(source, 'rev-parse', 'HEAD'), dirty: gitIn(source, 'status', '--porcelain', '--untracked-files=all') });

// Every child, history included, runs under the preload: same guards, same cost record.
function runChild(payload, { arm, armDir }) {
  fs.mkdirSync(armDir, { recursive: true });
  const payloadFile = path.join(armDir, 'payload.json');
  const inputs = path.join(armDir, 'scheduler-inputs.jsonl');
  fs.rmSync(inputs, { force: true });
  fs.writeFileSync(payloadFile, JSON.stringify(payload));
  const env = { ...process.env, HUQAN_G1_ARM: arm, HUQAN_G1_INPUTS: inputs, HUQAN_G1_ARM_DIRECTORY: armDir };
  delete env.NODE_TEST_CONTEXT;
  const before = sourceState(payload.source);
  const child = spawnSync(process.execPath, ['--require', PRELOAD, CHILD, payloadFile], { env, encoding: 'utf8',
    timeout: CHILD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (child.error) throw child.error;
  if (child.status !== 0) throw new Error(`G1_CHILD_FAILED:${arm}:${(child.stderr || child.stdout).slice(-4000)}`);
  const after = sourceState(payload.source);
  const rows = readJsonl(inputs);
  return { ...JSON.parse(child.stdout), arm, schedulerInputs: rows.filter(row => row.used),
    cost: rows.find(row => row.cost)?.cost || null,
    // The shared source must stay read-only, or state would cross arms and episodes.
    sourceIntact: before.head === after.head && before.dirty === after.dirty && after.dirty === '' };
}

function copyState(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const name of fs.readdirSync(from)) if (/^(graph|journal)/u.test(name)) fs.copyFileSync(path.join(from, name), path.join(to, name));
}

// Train: HISTORY_PER_KIND real Coder results per kind, once; the frozen
// snapshot is the start state of every episode (no carry-over between episodes).
function buildHistory(corpus, baseDir, source) {
  const stateDir = path.join(baseDir, 'history', 'state');
  const summaryFile = path.join(baseDir, 'history', 'summary.json');
  const corpusDigest = corpusApi.corpusDigest(corpus);
  const cached = readJsonOrNull(summaryFile);
  if (cached?.corpusDigest === corpusDigest) return { stateDir, ...cached };
  // No summary means no finished build: a partial snapshot is discarded, never resumed.
  fs.rmSync(path.join(baseDir, 'history'), { recursive: true, force: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const tasks = corpusApi.FAMILIES.flatMap(family => corpus.splits.train.flatMap(group => group.units)
    .filter(unit => unit.family === family)
    .flatMap((unit, at) => unit.variants.map((variant, index) => ({ id: `g1-train-${family.slice(6)}-${at}${index}`,
      workKind: unit.workKind, family, ...variant })))
    .slice(0, corpusApi.HISTORY_PER_KIND));
  const result = runChild({ mode: 'history', source, stateDir, targets: path.join(baseDir, 'history', 'targets'), tasks },
    { arm: 'history', armDir: path.join(baseDir, 'history') });
  if (!result.cost || result.cost.modelCalls || result.cost.networkCalls || !result.sourceIntact)
    throw new Error(`G1_HISTORY_GUARD:${JSON.stringify({ cost: result.cost, sourceIntact: result.sourceIntact })}`);
  const perKind = {};
  for (const run of result.runs) {
    const row = perKind[run.workKind] ||= { runs: 0, failures: 0 };
    row.runs += 1; if (run.successes !== 1) row.failures += 1;
  }
  const summary = { corpusDigest, perKind, tasks: tasks.length, wallMs: result.wallMs };
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  return { stateDir, ...summary };
}

// Integrity per arm: fixed denominator, no completion the oracle contradicts,
// a cost record that exists and is zero, and an untouched shared source.
function armViolations(result) {
  const reject = [];
  if (result.denominator !== 4) reject.push('denominator_changed');
  for (const batch of result.steps) for (const step of batch.steps) {
    const id = step.id.replace(/^coder:/u, '');
    if (step.status === 'done' && !result.outcome[id]?.accepted) reject.push(`false_completion:${id}`);
  }
  if (!result.cost) reject.push('cost_missing');
  else if (result.cost.modelCalls || result.cost.networkCalls) reject.push('model_or_network_call');
  if (!result.sourceIntact) reject.push('source_mutated');
  return reject;
}

// A finished pair is stored with the code digest it ran under, so an interrupted
// run resumes without re-running it; any code change invalidates the record.
let codeDigestCache = null;
const codeDigest = () => (codeDigestCache ||= corpusApi.sha256([PRELOAD, CHILD, __filename,
  path.join(__dirname, 'cognitive-lab-g1-corpus.js'), path.join(__dirname, 'cognitive-lab-g1-stats.js')].map(fileDigest).join(':')));

function runPair(input) {
  const record = path.join(input.baseDir, 'episodes', input.label, 'pair.json');
  const key = corpusApi.sha256(corpusApi.canonical({ code: codeDigest(), tasks: input.tasks, seed: input.seed ?? 1,
    observeCandidate: input.observeCandidate ?? true, history: input.history.corpusDigest ?? null }));
  const stored = readJsonOrNull(record);
  if (stored?.key === key) return stored.pair;
  // Operator pause between pairs (CLI only): no pair is ever cut in the middle.
  if (Number(process.env.HUQAN_G1_STOP_AFTER) && Date.now() > Number(process.env.HUQAN_G1_STOP_AFTER)) throw new Error('G1_PAUSED');
  const pair = runPairNow(input);
  fs.writeFileSync(record, JSON.stringify({ key, pair }));
  return pair;
}

// The arm that runs first alternates by seed so warm caches favour neither arm's wall time.
function runPairNow({ tasks, history, baseDir, source, label, seed = 1, observeCandidate = true }) {
  const arms = {};
  for (const arm of seed % 2 ? ['control', 'candidate'] : ['candidate', 'control']) {
    const armDir = path.join(baseDir, 'episodes', label, arm);
    fs.rmSync(armDir, { recursive: true, force: true });
    copyState(history.stateDir, path.join(armDir, 'state'));
    arms[arm] = runChild({ mode: 'episode', source, stateDir: path.join(armDir, 'state'), targets: path.join(armDir, 'targets'),
      tasks, budget: BUDGET, observe: arm === 'control' || observeCandidate }, { arm, armDir });
  }
  const first = arm => JSON.stringify(arms[arm].schedulerInputs[0]?.exceptUrgency ?? null);
  const insufficient = [];
  if (!arms.control.schedulerInputs.length || first('control') !== first('candidate')) insufficient.push(`arm_inputs_diverge:${label}`);
  // Each arm must spend its whole step budget; a run that stops early for any
  // other reason measures the machine, not M7.
  for (const arm of ['control', 'candidate']) {
    const spent = arms[arm].steps.reduce((sum, batch) => sum + batch.steps.length, 0);
    if (spent < Math.min(BUDGET.maxIterations, tasks.length)) insufficient.push(`step_budget_unspent:${arm}:${label}`);
  }
  const reject = [...armViolations(arms.control), ...armViolations(arms.candidate)].map(reason => `${reason}:${label}`);
  const slim = arm => ({ successes: arms[arm].successes, denominator: arms[arm].denominator, order: arms[arm].order,
    executed: arms[arm].steps.flatMap(batch => batch.steps.map(step => `${step.id}:${step.status}`)),
    wallMs: arms[arm].wallMs, cost: arms[arm].cost, counters: arms[arm].counters, maxRssBytes: arms[arm].maxRssBytes,
    urgencyUsed: arms[arm].schedulerInputs[0]?.used?.queued?.map(step => step.urgency ?? null) ?? [],
    urgencyByCall: arms[arm].schedulerInputs.map(row => Object.fromEntries(row.used.queued.map(step => [step.id, step.urgency ?? null]))) });
  return { label, control: slim('control'), candidate: slim('candidate'), insufficient, reject };
}

function runGroups({ groups, history, baseDir, source, split }) {
  return groups.map(group => ({ digest: group.digest, families: group.units.map(unit => unit.family),
    seeds: SEEDS.map(seed => runPair({ tasks: corpusApi.episodeTasks(group, seed), history, baseDir, source,
      label: `${split}-${group.digest.slice(0, 8)}-s${seed}`, seed })) }));
}

function costSummary(groups) {
  const pairs = groups.flatMap(group => group.seeds);
  const wall = arm => stats.median(pairs.map(pair => pair[arm].wallMs));
  const total = key => pairs.reduce((sum, pair) => sum + (pair.control.cost?.[key] || 0) + (pair.candidate.cost?.[key] || 0), 0);
  return { modelCalls: total('modelCalls'), networkCalls: total('networkCalls'), controlWallMedianMs: wall('control'),
    candidateWallMedianMs: wall('candidate'), wallRatio: wall('candidate') / wall('control'),
    maxRssBytes: Math.max(...pairs.flatMap(pair => [pair.control.maxRssBytes, pair.candidate.maxRssBytes])),
    coderSteps: pairs.reduce((sum, pair) => sum + pair.control.counters.coderSteps + pair.candidate.counters.coderSteps, 0) };
}

// Non-inferiority stratum, fixed before any episode: holdout groups whose two
// kinds showed no natural failure in the frozen train history (§7).
function stratumOf(corpus, history) {
  const clean = kind => (history.perKind[kind]?.failures ?? 1) === 0;
  return corpus.splits.holdout.filter(group => group.units.every(unit => clean(unit.workKind))).map(group => group.digest);
}

function antiCaseFixtures(corpus, baseDir) {
  const file = path.join(baseDir, 'anti-case-fixtures.json');
  const corpusDigest = corpusApi.corpusDigest(corpus);
  const cached = readJsonOrNull(file);
  if (cached?.corpusDigest === corpusDigest) return cached.fixtures;
  const fixtures = corpusApi.antiCaseFixtures(corpus);
  fs.writeFileSync(file, JSON.stringify({ corpusDigest, fixtures }));
  return fixtures;
}

function runAntiCases(corpus, history, baseDir, source) {
  const fixtures = antiCaseFixtures(corpus, baseDir);
  const results = {};
  for (const [name, tasks] of Object.entries(fixtures)) {
    if (!tasks) { results[name] = { status: 'FIXTURE_UNAVAILABLE' }; continue; }
    const pair = runPair({ tasks, history, baseDir, source, label: `anti-${name}` });
    const intact = !pair.reject.length && !pair.insufficient.length;
    const consistent = name === 'noFailure' ? pair.control.executed.every(step => step.endsWith(':done'))
      : name === 'bothFail' ? pair.control.successes === 0 && pair.candidate.successes === 0 : true;
    results[name] = { status: intact && consistent ? 'INTACT' : 'VIOLATED', pair };
  }
  return results;
}

// Did any task's urgency move between scheduler calls of one arm?
const urgencyMoved = calls => calls.slice(1).some(call => Object.entries(call).some(([id, value]) => value !== calls[0][id]));

// §8 mutation, as corrected in v3 §12 #5: the frozen train history gives M7 a
// signal before any in-episode observation, so equal choices with control is
// not the test. With observation cut, the candidate's urgency must stay frozen
// for the whole episode; with observation on, it must move in at least one
// calibration episode. Equal choices are still reported.
function runMutation(corpus, history, baseDir, source, groups) {
  const group = corpus.splits.calibration[0];
  const pair = runPair({ tasks: corpusApi.episodeTasks(group, SEEDS[0]), history, baseDir, source,
    label: 'mutation-observe-off', observeCandidate: false });
  const choices = arm => pair[arm].executed.map(step => step.split(':').slice(0, 2).join(':'));
  const frozenWithoutObservation = pair.candidate.urgencyByCall.length > 1 && !urgencyMoved(pair.candidate.urgencyByCall);
  const movesWithObservation = groups.some(row => row.seeds.some(seedPair => urgencyMoved(seedPair.candidate.urgencyByCall)));
  return { status: frozenWithoutObservation && movesWithObservation && !pair.reject.length ? 'INTACT' : 'VIOLATED',
    frozenWithoutObservation, movesWithObservation, sameChoicesAsControl: JSON.stringify(choices('control')) === JSON.stringify(choices('candidate')), pair };
}

const REPO = path.join(__dirname, '..');
// The main commit this checkout builds on: unlike a branch head, it survives a
// squash merge as an ancestor of main, so the holdout can still diff against it.
function sourceSha() {
  try { return gitIn(REPO, 'merge-base', 'HEAD', 'origin/main'); } catch { return null; }
}

// "No production code changes during the measurement" (§1): outside the runner's
// own files (pinned by digest) and non-runtime paths, the tree equals `base`.
const NON_PRODUCTION = [':!docs', ':!test', ':!scripts', ':!.github', ':!graphify-out', ':!coverage-manifest.json',
  ':!config/shard-weights.json', ':!lib/module-reachability.js', ':!lib/cognitive-lab-g1-*'];
function productionUnchangedSince(base) {
  try {
    gitIn(REPO, 'diff', '--quiet', base, '--', '.', ...NON_PRODUCTION);
    return gitIn(REPO, 'ls-files', '--others', '--exclude-standard', '--', '.', ':!node_modules', ...NON_PRODUCTION) === '';
  } catch { return false; }
}

// Everything the holdout must share with calibration: code, source and protocol.
function fingerprint(corpus) {
  return { corpusDigest: corpusApi.corpusDigest(corpus),
    protocol: { ...corpus.protocol, seeds: SEEDS, budget: BUDGET, minStratumGroups: MIN_STRATUM_GROUPS, minEffect: stats.MIN_EFFECT },
    digests: { preload: fileDigest(PRELOAD), episode: fileDigest(CHILD), runner: fileDigest(__filename),
      corpus: fileDigest(path.join(__dirname, 'cognitive-lab-g1-corpus.js')), stats: fileDigest(path.join(__dirname, 'cognitive-lab-g1-stats.js')),
      preregistration: fileDigest(PREREGISTRATION) } };
}

function runCalibration({ baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-g1-')), log = () => {} } = {}) {
  const corpus = corpusApi.buildG1Corpus();
  const audit = corpusApi.auditSplits(corpus);
  const base = sourceSha();
  if (!base || !productionUnchangedSince(base)) throw new Error('G1_CALIBRATION_NEEDS_CLEAN_PRODUCTION_TREE');
  const manifest = { schemaVersion: MANIFEST_SCHEMA, phase: 'calibration', sourceSha: base, ...fingerprint(corpus),
    splits: Object.fromEntries(Object.entries(corpus.splits).map(([split, groups]) => [split, groups.map(group => group.digest)])),
    audit };
  if (audit.status === 'LEAK') return { ...manifest, label: 'REJECT', reasons: ['split_leak_detected'] };
  if (audit.status !== 'CLEAN') return { ...manifest, label: 'INSUFFICIENT', reasons: ['split_audit_unavailable'] };
  const source = prepareSource(baseDir);
  log('history');
  const history = buildHistory(corpus, baseDir, source);
  log('calibration episodes');
  const groups = runGroups({ groups: corpus.splits.calibration, history, baseDir, source, split: 'calibration' });
  log('anti-cases and mutation');
  const antiCases = runAntiCases(corpus, history, baseDir, source);
  const mutation = runMutation(corpus, history, baseDir, source, groups);
  const deltas = groups.map(group => stats.groupDelta(group.seeds));
  const pairs = groups.flatMap(group => group.seeds);
  const failureRate = arm => 1 - pairs.reduce((sum, pair) => sum + pair[arm].successes, 0) / pairs.reduce((sum, pair) => sum + pair[arm].denominator, 0);
  const reject = pairs.flatMap(pair => pair.reject);
  const insufficient = [...pairs.flatMap(pair => pair.insufficient),
    ...Object.entries(antiCases).filter(([, row]) => row.status !== 'INTACT').map(([name]) => `anti_case_${name}`),
    ...(mutation.status === 'INTACT' ? [] : ['mutation_observe_off'])];
  const sigma = stats.sampleSd(deltas);
  return { ...manifest, history: { perKind: history.perKind, tasks: history.tasks },
    calibration: { deltas, sigma, naturalFailureRate: { control: failureRate('control'), candidate: failureRate('candidate') },
      cost: costSummary(groups), groups, antiCases, mutation, reject, insufficient },
    lock: reject.length || insufficient.length ? null : { holdoutGroups: stats.lockGroupCount(sigma), sigma,
      stratum: stratumOf(corpus, history) } };
}

// Pre-flight before the single-use marker: a refused run does not consume the holdout.
function checkLockedManifest(manifest, corpus) {
  if (manifest?.schemaVersion !== MANIFEST_SCHEMA || manifest.phase !== 'calibration' || !manifest.lock?.holdoutGroups
    || !Array.isArray(manifest.lock.stratum)) throw new Error('G1_HOLDOUT_NEEDS_LOCKED_MANIFEST');
  if (!manifest.sourceSha || !productionUnchangedSince(manifest.sourceSha)) throw new Error('G1_MANIFEST_MISMATCH:production');
  const live = fingerprint(corpus);
  const recorded = { corpusDigest: manifest.corpusDigest, protocol: manifest.protocol, digests: manifest.digests };
  for (const key of Object.keys(live)) {
    if (corpusApi.canonical(live[key]) !== corpusApi.canonical(recorded[key])) throw new Error(`G1_MANIFEST_MISMATCH:${key}`);
  }
}

function runHoldout({ manifest, baseDir, reportFile, log = () => {} }) {
  const corpus = corpusApi.buildG1Corpus();
  checkLockedManifest(manifest, corpus);
  const audit = corpusApi.auditSplits(corpus);
  // The holdout opens once: 'wx' fails if any earlier attempt left a report or marker.
  try { fs.writeFileSync(reportFile, JSON.stringify({ status: 'RUNNING', startedAt: new Date().toISOString() }), { flag: 'wx' }); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('G1_HOLDOUT_ALREADY_RUN'); throw error; }
  try {
    return holdoutReport({ manifest, corpus, audit, baseDir, reportFile, log });
  } catch (error) {
    // A crashed run is recorded, never silently retried.
    const failed = { schemaVersion: MANIFEST_SCHEMA, phase: 'holdout', label: 'INSUFFICIENT',
      reasons: [`holdout_run_failed:${String(error.message).slice(0, 2000)}`] };
    fs.writeFileSync(reportFile, JSON.stringify(failed, null, 2));
    return failed;
  }
}

function holdoutReport({ manifest, corpus, audit, baseDir, reportFile, log }) {
  const holdout = corpus.splits.holdout.slice(0, manifest.lock.holdoutGroups);
  let groups = [];
  if (audit.status === 'CLEAN') {
    const source = prepareSource(baseDir);
    const history = buildHistory(corpus, baseDir, source);
    log(`holdout ${holdout.length} groups`);
    groups = runGroups({ groups: holdout, history, baseDir, source, split: 'holdout' });
  }
  const pairs = groups.flatMap(group => group.seeds);
  const deltas = groups.map(group => stats.groupDelta(group.seeds));
  const interval = deltas.length ? stats.pairedBootstrap(deltas) : null;
  const stratumGroups = groups.filter(group => manifest.lock.stratum.includes(group.digest));
  const stratum = { groups: stratumGroups.length, minGroups: MIN_STRATUM_GROUPS,
    interval: stratumGroups.length ? stats.pairedBootstrap(stratumGroups.map(group => stats.groupDelta(group.seeds))) : null };
  const cost = groups.length ? costSummary(groups) : null;
  const rejectReasons = [...(audit.status === 'LEAK' ? ['split_leak_detected'] : []), ...pairs.flatMap(pair => pair.reject)];
  const insufficientReasons = [...(audit.status === 'UNAVAILABLE' ? ['split_audit_unavailable'] : []),
    ...(groups.length < manifest.lock.holdoutGroups ? ['holdout_groups_short'] : []), ...pairs.flatMap(pair => pair.insufficient)];
  const decision = stats.labelResult({ rejectReasons, insufficientReasons, interval: interval || { lower: 0, upper: 0 }, stratum, cost: cost || {} });
  const report = { schemaVersion: MANIFEST_SCHEMA, phase: 'holdout', claim: 'G1 synthetic measurement only (§10)',
    manifestDigest: corpusApi.sha256(corpusApi.canonical(manifest)), sourceSha: sourceSha(), audit, deltas, interval,
    signTest: deltas.length ? stats.signTest(deltas) : null, stratum, cost, groups, ...decision };
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  return report;
}

module.exports = { MANIFEST_SCHEMA, SEEDS, BUDGET, runCalibration, runHoldout, runPair, prepareSource, buildHistory,
  armViolations, checkLockedManifest, fingerprint };

if (require.main === module) {
  const [command, out, manifestFile] = process.argv.slice(2);
  const log = message => process.stderr.write(`[g1] ${new Date().toISOString()} ${message}\n`);
  const baseDir = path.resolve(process.env.HUQAN_G1_WORKDIR || fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-g1-')));
  if (command === 'calibrate' && out) {
    try { fs.writeFileSync(out, JSON.stringify(runCalibration({ baseDir, log }), null, 2)); }
    catch (error) { if (error.message !== 'G1_PAUSED') throw error; log('paused; rerun the same command to resume'); process.exitCode = 75; }
  } else if (command === 'holdout' && out && manifestFile) {
    runHoldout({ manifest: JSON.parse(fs.readFileSync(manifestFile, 'utf8')), baseDir, reportFile: out, log });
  } else {
    process.stderr.write('usage: node lib/cognitive-lab-g1-holdout.js calibrate <manifest.json> | holdout <report.json> <manifest.json>\n');
    process.exitCode = 2;
  }
}
