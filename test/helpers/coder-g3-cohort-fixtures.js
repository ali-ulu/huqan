'use strict';

/**
 * Shared fixtures for the G3 Coder learning-gain evals (#4380, #4416).
 *
 * Both measurements — the two-family cohort (#4380) and the power + repeated
 * cost slice (#4416) — drive the same real entry point (`cli.js coder ...`) over
 * the same shape of temporary Git repository. Only the corpus differs. Keeping
 * the fixture construction here means the two measurements cannot drift apart:
 * a change to how a task is installed or how the tree is snapshotted reaches
 * both, so their results stay comparable.
 *
 * Everything here runs real code: real files, real `git`, real child processes
 * via `spawnSync`. Nothing is mocked.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync, spawnSync } = require('node:child_process');

const CLI = path.resolve(__dirname, '..', '..', 'cli.js');
const CPU_PROBE = path.resolve(__dirname, 'coder-cpu-probe.js');

const digest = text => crypto.createHash('sha256').update(text).digest('hex');

function write(root, file, text) {
  fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  fs.writeFileSync(path.join(root, file), text);
}

function commit(root) {
  const git = args => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git(['add', 'src', 'test', 'qualify', '.gitignore']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'fixture']);
}

// §4 family A — arithmetic-expression. The buggy body is `p => p + 1`; the real
// target is `expected`. A test process appends one line per assertion run, which
// is how the measurement counts verification processes.
function arithFixture(name, checks, expected = input => input % 2) {
  return `const fs = require('node:fs'); fs.mkdirSync('.huqan/gain', { recursive: true });
fs.appendFileSync('.huqan/gain/${name}.log', 'test-process\\n');
const assert = require('node:assert/strict'); const f = require('../src/${name}');
${checks.map(input => `assert.equal(f(${input}), ${expected(input)});`).join('\n')}
`;
}

function installArith(root, item, expected = input => input % 2) {
  const content = `module.exports = ${item.parameter} => ${item.parameter} + 1;\n`;
  const task = { id: item.name, level: 'l0', allowedPaths: [`src/${item.name}.js`],
    operation: { type: 'replace_text', path: `src/${item.name}.js` },
    test: { command: `node test/${item.name}.js` },
    synthesis: { family: 'arithmetic-expression',
      examples: item.examples.map(input => ({ input, expected: expected(input) })) } };
  write(root, `src/${item.name}.js`, content);
  write(root, `test/${item.name}.js`, arithFixture(item.name, item.checks, expected));
  write(root, `${item.name}.json`, JSON.stringify(task));
  return { task, content, taskHash: digest(JSON.stringify(task)), testHash: digest(arithFixture(item.name, item.checks, expected)) };
}

// §4 family B — string-expression. The buggy body is `p.toUpperCase()`; the real
// target is `p.trim().toLowerCase()`. Synthesis examples are lower-case, so
// several programs match and only the real test separates them.
function stringFixture(name, checks) {
  return `const fs = require('node:fs'); fs.mkdirSync('.huqan/gain', { recursive: true });
fs.appendFileSync('.huqan/gain/${name}.log', 'test-process\\n');
const assert = require('node:assert/strict'); const f = require('../src/${name}');
${checks.map(([input, expected]) => `assert.equal(f(${JSON.stringify(input)}), ${JSON.stringify(expected)});`).join('\n')}
`;
}

function installString(root, item) {
  const content = `function ${item.fn}(${item.parameter}) { return ${item.parameter}.toUpperCase(); }\nmodule.exports = ${item.fn};\n`;
  const task = { id: item.name, level: 'l0', allowedPaths: [`src/${item.name}.js`],
    operation: { type: 'replace_text', path: `src/${item.name}.js` },
    test: { command: `node test/${item.name}.js` },
    synthesis: { family: 'string-expression', functionName: item.fn,
      examples: item.examples.map(([input, expected]) => ({ input, expected })) } };
  write(root, `src/${item.name}.js`, content);
  write(root, `test/${item.name}.js`, stringFixture(item.name, item.checks));
  write(root, `${item.name}.json`, JSON.stringify(task));
  return { task, content, taskHash: digest(JSON.stringify(task)), testHash: digest(stringFixture(item.name, item.checks)) };
}

// A full content snapshot of the working tree, ignoring only runtime state
// (`node_modules`, `.huqan/`) and the SQLite databases (`journal.db`,
// `memory.db`, and their `-wal`/`-shm` sidecars). This is stronger than
// `git status --porcelain`: the fixtures ignore `*.json`, so git would not
// report a stray write to a task JSON file, but this does.
const SNAPSHOT_IGNORE = new Set(['.git', '.huqan', 'node_modules']);
const isRuntimeFile = name => /\.db(-(wal|shm|journal))?$/.test(name);
function snapshotTree(root) {
  const files = {};
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SNAPSHOT_IGNORE.has(entry.name) || isRuntimeFile(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files[path.relative(root, full).split(path.sep).join('/')] = digest(fs.readFileSync(full));
    }
  };
  walk(root);
  return files;
}

function changedPaths(before, after) {
  return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(file => before[file] !== after[file]).sort();
}

// Zero mis-write tolerance, measured rather than read off the contract: each
// deviation is counted so a report can say REJECT by measurement, not a constant.
function createWrongWriteCounter() {
  let count = 0;
  return {
    get count() { return count; },
    assertChangedPaths(actual, expected, label) {
      count += actual.filter(file => !expected.includes(file)).length;
      const assert = require('node:assert/strict');
      assert.deepEqual(actual, expected, `${label}: changed ${JSON.stringify(actual)}`);
    },
  };
}

// Sum of child CPU rows. A missing log (`null`) and an empty log both mean the
// probe recorded nothing, so both are `null` (unmeasured), not a measured 0.
function sumCpu(cpu) {
  return cpu && cpu.length ? cpu.reduce((total, row) => total + row.totalMs, 0) : null;
}

// Fail closed on an incomplete CPU sample: `null` when the log was not captured
// or empty, otherwise whether every spawned process (the CLI plus one per test
// process) contributed a row. A short log means a process died before it
// appended, so the caller reports NOT_MEASURED instead of a smaller total.
function isCpuComplete(cpu, processes) {
  return cpu === null ? null : cpu.length >= processes + 1;
}

// Whether a run's CPU sample is usable. A run with no log, an empty log, or a
// short log is unmeasured: the caller must treat that as NOT_MEASURED, not as a
// smaller total, so an unmeasured cost cannot reach GAIN.
function cpuSampleComplete(run) {
  return sumCpu(run.cpu) !== null && run.cpuComplete !== false;
}

// Runs one real CLI invocation. `cpuLog`, when given, makes the run capture the
// CPU/RSS of every Node process it spawns (the CLI plus each test process) by
// preloading the probe; the parsed lines come back as `cpu`.
function run(root, name, mode, options = {}) {
  const { expectedStatus = 0, cpuLog } = options;
  const before = snapshotTree(root);
  const env = { ...process.env, HUQAN_STATE_ROOT: path.join(root, '.huqan', 'runtime-state') };
  if (cpuLog) {
    // NODE_OPTIONS splits on whitespace, so a probe path with spaces (a Windows
    // temp or repo path) must be quoted or the loader sees two arguments.
    const probe = CPU_PROBE.includes(' ') ? `"${CPU_PROBE}"` : CPU_PROBE;
    env.NODE_OPTIONS = `${env.NODE_OPTIONS || ''} --require ${probe}`.trim();
    env.HUQAN_CPU_LOG = cpuLog;
    fs.rmSync(cpuLog, { force: true });
  }
  const started = process.hrtime.bigint();
  const child = spawnSync(process.execPath, [CLI,
    'coder', `${name}.json`, mode, '--authorize', '--root', root,
    '--journal', path.join(root, 'journal.db'), '--run-id', name, '--json'], {
    cwd: root, encoding: 'utf8', timeout: 120000, maxBuffer: 1048576, env,
  });
  const wallMs = Number(process.hrtime.bigint() - started) / 1e6;
  const assert = require('node:assert/strict');
  assert.equal(child.error, undefined, String(child.error));
  assert.equal(child.status, expectedStatus, child.stdout + child.stderr);
  const result = JSON.parse(child.stdout);
  const log = path.join(root, '.huqan', 'gain', `${name}.log`);
  const processes = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('test-process').length - 1 : 0;
  const cpu = cpuLog && fs.existsSync(cpuLog)
    ? fs.readFileSync(cpuLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    : null;
  // Every process a run spawns inherits NODE_OPTIONS, so the probe should record
  // one row for the CLI plus one per test process. Fewer rows mean a process
  // died before it appended, so its CPU is missing; the caller must treat that as
  // NOT_MEASURED rather than a smaller total. Extra rows are not treated as
  // failure (an unexpected process can only add, never hide, CPU).
  const cpuComplete = isCpuComplete(cpu, processes);
  return { result, processes, wallMs, cpu, cpuComplete, changed: changedPaths(before, snapshotTree(root)) };
}

module.exports = {
  CLI, CPU_PROBE, digest, write, commit,
  arithFixture, installArith, stringFixture, installString,
  snapshotTree, changedPaths, createWrongWriteCounter, run,
  sumCpu, isCpuComplete, cpuSampleComplete,
};
