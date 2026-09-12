'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  DEFAULT_SHARDS,
  REPO_ROOT,
  discoverTestFiles,
  getShard,
} = require('./ci-shard-manifest');
const { createTestStateSandbox } = require('./test-state-sandbox');
const { mergeJunitParts } = require('./junit-merge');

function parseArgs(argv) {
  const options = {
    shard: null,
    total: DEFAULT_SHARDS,
    // Several legacy tests intentionally share default JSON persistence within
    // a process-level test run. CI parallelism is provided by separate shard
    // runners; keep each runner serial unless a future isolation audit proves
    // a higher value safe.
    concurrency: 1,
    report: null,
    selection: null,
    list: false,
  };
  for (const arg of argv) {
    if (arg === '--list') {
      options.list = true;
      continue;
    }
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (!match) throw new Error(`unsupported argument: ${arg}`);
    const [, key, value] = match;
    if (key === 'shard') options.shard = Number(value);
    else if (key === 'total') options.total = Number(value);
    else if (key === 'concurrency') options.concurrency = Number(value);
    else if (key === 'report') options.report = value;
    else if (key === 'selection') options.selection = value;
    else throw new Error(`unsupported argument: ${arg}`);
  }
  return options;
}

function assertPositiveInteger(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer, got ${value}`);
}

function defaultReportPath(shard) {
  return path.join(os.tmpdir(), `huqan-test-shard-${shard}.xml`);
}

/**
 * Where this shard records which files failed, beside its JUnit report.
 *
 * The merged JUnit report cannot answer that question: it is assembled from
 * <testsuite> blocks, and a file declaring only top-level `test(...)` calls
 * emits none, so every result in it -- pass and fail alike -- is dropped. On
 * 2026-09-05 shard 5 exited non-zero on test/enforcement-coverage.test.js and
 * uploaded a report saying failures="0". The nightly alarm reads this sidecar.
 */
function failuresSidecarPath(reportPath, shard) {
  return path.join(path.dirname(reportPath), `test-shard-${shard}-failures.json`);
}

function loadSelection(selectionPath, knownFiles) {
  const absolute = path.resolve(selectionPath);
  const plan = JSON.parse(fs.readFileSync(absolute, 'utf8'));
  if (!plan || plan.schemaVersion !== 1 || !Array.isArray(plan.selectedTests)) {
    throw new Error('selection manifest must contain schemaVersion=1 and selectedTests[]');
  }
  const known = new Set(knownFiles);
  const selected = [...new Set(plan.selectedTests.map((file) => String(file).replaceAll('\\', '/')))].sort();
  if (selected.length === 0) throw new Error('selection manifest selectedTests must not be empty');
  const unknown = selected.filter((file) => !known.has(file));
  if (unknown.length > 0) throw new Error(`selection manifest references unknown test files: ${unknown.join(', ')}`);
  return selected;
}

function run(options) {
  assertPositiveInteger(options.total, 'total');
  assertPositiveInteger(options.shard, 'shard');
  assertPositiveInteger(options.concurrency, 'concurrency');
  if (options.shard > options.total) throw new Error(`shard must be between 1 and ${options.total}, got ${options.shard}`);

  const files = discoverTestFiles(REPO_ROOT);
  const selectedFiles = options.selection ? loadSelection(options.selection, files) : files;
  const selected = getShard(selectedFiles, options.shard, options.total);
  const reportPath = path.resolve(options.report || defaultReportPath(options.shard));
  fs.mkdirSync(path.dirname(reportPath), { recursive: true });

  console.log(`Running shard ${options.shard}/${options.total}: ${selected.files.length} test files, estimated weight ${selected.weight.toFixed(3)}s${options.selection ? ` (selection=${options.selection})` : ''}`);
  if (selected.files.length === 0) {
    fs.writeFileSync(reportPath, '<?xml version="1.0" encoding="utf-8"?>\n<testsuites tests="0" failures="0" skipped="0" time="0" />\n');
    console.log('No tests assigned to this shard; skipping Node test discovery.');
    return 0;
  }
  if (options.list) {
    for (const file of selected.files) console.log(file);
    return 0;
  }

  // Sharded runs get the same throwaway gate state root as `npm test`: a shard
  // run on a developer machine must not read or extend the operator's live
  // policy and receipt trail either (#1846).
  //
  // #2032: the root is created per file rather than once per shard. The files
  // in a shard are otherwise fully separate -- one process each, their own
  // mkdtemp fixtures, ephemeral ports -- so this root was their only shared
  // mutable surface, and the receipt trail under it accumulated across every
  // preceding file. It is also the one thing that differs between
  // `node scripts/run-tests.js <file>` and the same file inside a shard, which
  // is exactly the "passes alone, fails in shard" shape. Per file, a shard run
  // now reproduces the solo run instead of a 157-file history.

  // Announce the full plan upfront so a hang that occurs before the first
  // file starts is still diagnosable, then announce each file as it starts
  // so the next "still running at 22m" points at a single file rather than
  // an opaque shard (#1847).
  for (const file of selected.files) {
    console.log(`[shard ${options.shard}/${options.total}] queued ${file}`);
  }

  const partPaths = [];
  const failedFiles = [];
  let overallStatus = 0;
  let lastSignal = null;

  try {
    for (let index = 0; index < selected.files.length; index += 1) {
      const file = selected.files[index];
      const partPath = `${reportPath}.part-${index + 1}.xml`;
      partPaths.push(partPath);
      const startedAt = new Date().toISOString();
      const startedMs = Date.now();
      const sandbox = createTestStateSandbox();
      // The state root is named on the starting line rather than logged
      // separately: it adds no line to a 157-file shard, it tells a hung file's
      // investigator where that file's state actually lives, and it is what
      // makes "every file got its own root" observable from outside instead of
      // a property only the source can attest to (#2032).
      console.log(`[shard ${options.shard}/${options.total}] starting ${index + 1}/${selected.files.length}: ${file} at ${startedAt} state-root ${sandbox.stateRoot}`);
      let result;
      try {
        result = spawnSync(process.execPath, [
          '--test',
          `--test-concurrency=${options.concurrency}`,
          '--test-reporter=junit',
          `--test-reporter-destination=${partPath}`,
          file,
        ], {
          cwd: REPO_ROOT,
          env: sandbox.environment,
          stdio: 'inherit',
          // Cap the indefinite "still running at 22m" (#1847) at the file that
          // actually hangs. Historical max per-file is ~25s; 90s is 3-4x margin
          // for slow Linux runners but fails fast instead of waiting for the
          // 20m job timeout from #1845.
          timeout: 90_000,
          killSignal: 'SIGTERM',
        });
      } finally {
        sandbox.cleanup();
      }

      if (result.error) {
        if (result.error.code === 'ETIMEDOUT') {
          const elapsed = ((Date.now() - startedMs) / 1000).toFixed(3);
          console.error(`[shard ${options.shard}/${options.total}] file ${file} timed out after 90s (elapsed ${elapsed}s, signal ${result.signal || 'SIGTERM'}) — killed hanging file, see #1847`);
          overallStatus = 1;
          failedFiles.push({ file, status: 'timeout' });
          // Leave a minimal JUnit entry so the merged report shows the hang
          // as a failure instead of silently dropping the file.
          try {
            if (!fs.existsSync(partPath) || fs.readFileSync(partPath, 'utf8').trim().length === 0) {
              const safe = file.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
              fs.writeFileSync(partPath, `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n<testsuite name="${safe}" tests="1" failures="1" errors="0" skipped="0" time="90.000"><testcase name="shard timeout (90s) — file hung" classname="shard"><failure message="file hung and was killed after 90s">File ${safe} did not exit within 90s (likely CDP/browser hang, see #1847). Check the preceding [shard] starting log.</failure></testcase></testsuite>\n</testsuites>\n`);
            }
          } catch { /* ignore */ }
          continue;
        }
        throw result.error;
      }
      if (result.signal) {
        console.error(`[shard ${options.shard}/${options.total}] file ${file} terminated by signal ${result.signal}`);
        lastSignal = result.signal;
        overallStatus = 1;
        failedFiles.push({ file, status: `signal ${result.signal}` });
        break;
      }
      const status = result.status === 0 ? 0 : (result.status || 1);
      const elapsed = ((Date.now() - startedMs) / 1000).toFixed(3);
      console.log(`[shard ${options.shard}/${options.total}] finished ${index + 1}/${selected.files.length}: ${file} -> status ${status} in ${elapsed}s`);
      if (status !== 0) {
        failedFiles.push({ file, status });
        if (overallStatus === 0) overallStatus = status;
      }
    }
  } finally {
    // Each file's sandbox is already removed in its own `finally` above.
    // Written in `finally` so a shard that throws still leaves the alarm
    // something to read; best-effort, because failing to write the sidecar
    // must not change the shard's own verdict.
    try {
      fs.writeFileSync(
        failuresSidecarPath(reportPath, options.shard),
        `${JSON.stringify({ shard: options.shard, total: options.total, failedFiles }, null, 2)}\n`,
      );
    } catch (error) {
      console.error(`warning: failed to write the shard failure sidecar: ${error.message}`);
    }
  }

  mergeJunitParts(partPaths, selected.files, reportPath);

  console.log(`JUnit timing report: ${reportPath}`);
  if (lastSignal) {
    console.error(`test shard terminated by signal ${lastSignal}`);
    return 1;
  }
  return overallStatus;
}

// JUnit parsing/merging lives in scripts/junit-merge.js (#2212); run() below
// keeps process orchestration, shard selection and exit codes only.

if (require.main === module) {
  try {
    process.exitCode = run(parseArgs(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = {
  defaultReportPath,
  failuresSidecarPath,
  loadSelection,
  mergeJunitParts,
  parseArgs,
  run,
};
