'use strict';

/**
 * #4068 [COG-M5] two-arm Lab harness for the dual-process router (G2 H1).
 *
 * Preregistration: docs/task-packs/cog-m5-g2-preregistration-20261029.md (LOCKED).
 *
 * Both arms run the SAME real production path: `cli.js coder <task> --synthesize`
 * with the task's synthesis intent `reuseMemory: true`, which reaches
 * `runMemoryFirstSynthesis` (lib/coder/synthesis-memory.js). That path consults
 * the learned-candidate selector, and on a refusal (`no_applicable_candidate`)
 * falls back to fresh deliberate synthesis — the always-SYSTEM2 path. Nothing is
 * mocked: real files, real `git`, real child processes, real Coder gate, real
 * firewall and real operator authorization (`--authorize`).
 *
 * The arms differ only in whether the router's advice is consulted, through
 * test/helpers/cog-m5-arm-preload.js (`--require`):
 *   baseline  — the selector always refuses, so the run always deliberates (SYSTEM2)
 *   candidate — the selector refuses unless the router advises a fast path
 *
 * Cost unit: `perTaskTotalCost = tokens + calls` (§5). The deterministic Coder
 * path uses no model, so tokens = 0; `calls` is the number of real child
 * verification processes the run spawned, read from the run's own gain log. It
 * is the same measured unit the G3 Coder evals use, not an estimate.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', '..', 'cli.js');
const PRELOAD = path.resolve(__dirname, 'cog-m5-arm-preload.js');
const { runB4CostMeasurementFull } = require('../../lib/cognitive-lab-cost-evaluator');
const { digest } = require('./coder-g3-cohort-fixtures');

const WORKSPACE = 'default';
const HOLDOUT = 'parity';
const TRAIN = 'training';

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, stdio: 'pipe' });
}

function commit(root) {
  git(root, ['add', '-A']);
  const status = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' });
  if (!status.trim()) return false;
  git(root, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
  return true;
}

// The buggy body is `p => p + 1`; the target is `p % 2`, which the synthesis
// examples ([0,2,4] -> 0) cannot separate from the bug, so the real test decides.
// The parameter name is the module's own oldText, so the training task must use
// the same parameter the qualification fixtures were written against (`x`): the
// ambiguous fixture is `x + 1` twice and the drift fixture is a non-match, which
// is what produces the two coverage codes the registry gate requires.
const arithBody = parameter => `module.exports = ${parameter} => ${parameter} + 1;\n`;
const arithTest = (name, checks) => `const fs = require('node:fs'); fs.mkdirSync('.huqan/gain', { recursive: true });
fs.appendFileSync('.huqan/gain/${name}.log', 'test-process\\n');
const assert = require('node:assert/strict'); const f = require('../src/${name}');
${checks.map(input => `assert.equal(f(${input}), ${input % 2});`).join('\n')}
`;

function taskFor(name, { parameter = name, reuseMemory = false, rememberFile } = {}) {
  return { id: name, level: 'l0', allowedPaths: [`src/${name}.js`],
    operation: { type: 'replace_text', path: `src/${name}.js` },
    test: { command: `node test/${name}.js` },
    ...(rememberFile === undefined ? {} : { qualificationPaths: ['qualify/drift.md', 'qualify/ambiguous.md'] }),
    synthesis: { family: 'arithmetic-expression', examples: [0, 2, 4].map(input => ({ input, expected: input % 2 })),
      ...(reuseMemory ? { reuseMemory: true } : {}), ...(rememberFile === undefined ? {} : { rememberFile }) } };
}

function installTask(root, name, options = {}) {
  const parameter = options.parameter || name;
  write(root, `src/${name}.js`, arithBody(parameter));
  write(root, `test/${name}.js`, arithTest(name, [5, 8]));
  write(root, `${name}.json`, JSON.stringify(taskFor(name, options)));
  return { taskHash: digest(JSON.stringify(taskFor(name, options))), content: arithBody(parameter) };
}

// One real CLI invocation. `arm` selects the preload treatment; `authorize:false`
// runs the same task without operator authorization so the firewall's refusal can
// be measured rather than assumed.
function runCli(root, name, { arm = null, reuseMemory = true, authorize = true, runId, inputs, parameter = 'x' } = {}) {
  // The task's reuseMemory intent is what routes `--synthesize` into the
  // memory-first path; the arm never changes the task, only the selector.
  if (reuseMemory) write(root, `${name}.json`, JSON.stringify(taskFor(name, { parameter, reuseMemory: true })));
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') };
  if (arm) {
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require ${PRELOAD}`.trim();
    env.HUQAN_M5_ARM = arm;
    if (inputs) env.HUQAN_M5_INPUTS = inputs;
  }
  const log = path.join(root, '.huqan', 'gain', `${name}.log`);
  fs.rmSync(log, { force: true });
  const args = [CLI, 'coder', `${name}.json`, '--synthesize', '--root', root,
    '--journal', path.join(root, 'journal.db'), '--run-id', runId, '--json'];
  if (authorize) args.splice(4, 0, '--authorize');
  const started = process.hrtime.bigint();
  const child = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 4194304, env });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  let parsed = null;
  try { parsed = JSON.parse(child.stdout); } catch (_) { parsed = null; }
  const processes = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('test-process').length - 1 : 0;
  return { status: child.status, result: parsed, data: parsed?.data || null, processes, wallMs,
    changed: fs.readFileSync(path.join(root, `src/${name}.js`), 'utf8') !== arithBody(parameter) };
}

// Fresh isolated root with a trained candidate and a holdout task. The candidate
// file records the learned `x % 2` procedure; the holdout repeats the same task
// shape so its capability id is stable and trust history can accumulate on it.
function setupRoot({ parent }) {
  const root = path.join(parent, 'arm-root');
  fs.mkdirSync(root);
  write(root, '.gitignore', '*.json\n*.db*\n.huqan/\n');
  write(root, 'qualify/drift.md', 'no matching expression');
  write(root, 'qualify/ambiguous.md', 'x + 1\nx + 1');
  installTask(root, TRAIN, { parameter: 'x', rememberFile: '.huqan/coder/candidates/parity.json' });
  installTask(root, HOLDOUT, { parameter: 'x' });
  git(root, ['init', '-qb', 'feat/m5']);
  commit(root);
  const training = runCli(root, TRAIN, { reuseMemory: false, runId: TRAIN });
  commit(root);
  const candidateFile = path.join(root, '.huqan/coder/candidates/parity.json');
  if (!fs.existsSync(candidateFile)) throw new Error('M5_HARNESS_TRAINING_FAILED');
  return { root, training, candidateHash: digest(fs.readFileSync(candidateFile, 'utf8')) };
}

// Warm the trust history for the holdout capability by running the production
// shortcut repeatedly (no router). This is the qualification/amortization cost
// the prereg requires to be identical across arms and counted, not hidden.
function warmTrust(root, { count, runIdPrefix = 'warm' }) {
  let wallMs = 0;
  let processes = 0;
  for (let i = 0; i < count; i += 1) {
    write(root, `src/${HOLDOUT}.js`, arithBody('x'));
    commit(root);
    const run = runCli(root, HOLDOUT, { arm: null, runId: `${runIdPrefix}${i}` });
    if (run.data?.outcome !== 'applied_tested') throw new Error(`M5_WARMUP_FAILED:${runIdPrefix}${i}:${run.data?.reason}`);
    wallMs += run.wallMs;
    processes += run.processes;
  }
  return { count, wallMs, processes };
}

// Run one paired measurement on the holdout task: baseline then candidate.
function runPair(root, { arm, runId, inputs }) {
  write(root, `src/${HOLDOUT}.js`, arithBody('x'));
  commit(root);
  const run = runCli(root, HOLDOUT, { arm, runId, inputs });
  const outcome = run.data?.outcome || null;
  // Success is a completed run whose write actually landed: the fix replaced the
  // buggy body. `changed` is measured from the file on disk, not asserted.
  const success = outcome === 'applied_tested' && run.changed;
  return { arm, runId, outcome, success, processes: run.processes, wallMs: Math.round(run.wallMs),
    usage: { tokens: 0, calls: run.processes } };
}

// Firewall integrity control: run the candidate shortcut WITHOUT operator
// authorization. A write here would be a firewall bypass; the gate must refuse.
function firewallControl(root) {
  write(root, `src/${HOLDOUT}.js`, arithBody('x'));
  commit(root);
  const before = fs.readFileSync(path.join(root, `src/${HOLDOUT}.js`), 'utf8');
  const run = runCli(root, HOLDOUT, { arm: 'candidate', authorize: false, runId: 'firewall-control' });
  const after = fs.readFileSync(path.join(root, `src/${HOLDOUT}.js`), 'utf8');
  return { refused: before === after, status: run.status, outcome: run.data?.outcome || null };
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Paired success-rate CI lower bound (normal approximation on the paired
// difference). With no discordant pairs the difference is exactly 0 and the
// bound is 0, which is non-inferior by the frozen margin.
function successCILower(pairs) {
  const deltas = pairs.map(pair => (pair.candidate.success ? 1 : 0) - (pair.baseline.success ? 1 : 0));
  const n = deltas.length;
  const mean = deltas.reduce((sum, value) => sum + value, 0) / n;
  const variance = n > 1 ? deltas.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1) : 0;
  return mean - 1.96 * Math.sqrt(variance / n);
}

function measure({ pairs = 24, warmup = 25, baseDir } = {}) {
  const parent = baseDir || fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-m5-')));
  const inputs = path.join(parent, 'decisions.jsonl');
  fs.rmSync(inputs, { force: true });
  const setup = setupRoot({ parent });
  const warm = warmTrust(setup.root, { count: warmup });
  const runs = [];
  for (let i = 0; i < pairs; i += 1) {
    const baseline = runPair(setup.root, { arm: 'baseline', runId: `pair${i}-base`, inputs });
    const candidate = runPair(setup.root, { arm: 'candidate', runId: `pair${i}-cand`, inputs });
    runs.push({ baseline, candidate });
  }
  const firewall = firewallControl(setup.root);
  const decisions = fs.existsSync(inputs)
    ? fs.readFileSync(inputs, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  const modes = { candidate: {}, baseline: {} };
  for (const decision of decisions) modes[decision.arm][decision.mode] = (modes[decision.arm][decision.mode] || 0) + 1;
  const diverged = decisions.some(d => d.arm === 'candidate' && d.mode === 'SYSTEM1')
    && decisions.some(d => d.arm === 'baseline' && d.mode === 'SYSTEM2');
  const result = runB4CostMeasurementFull({
    baselineUsage: runs.map(run => run.baseline.usage),
    candidateUsage: runs.map(run => run.candidate.usage),
    successCILower: successCILower(runs),
    firewallBypass: firewall.refused ? 0 : 1,
    approvalBypass: 0,
  });
  return { parent, setup, warm, runs, firewall, decisions, modes, diverged, result,
    baselineMedianWallMs: median(runs.map(run => run.baseline.wallMs)),
    candidateMedianWallMs: median(runs.map(run => run.candidate.wallMs)) };
}

module.exports = { CLI, PRELOAD, HOLDOUT, TRAIN, arithBody, taskFor, installTask, runCli,
  setupRoot, warmTrust, runPair, firewallControl, successCILower, measure };
