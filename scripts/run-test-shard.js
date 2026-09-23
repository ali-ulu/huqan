'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  DEFAULT_SHARDS,
  REPO_ROOT,
  discoverTestFiles,
  getShard,
} = require('./ci-shard-manifest');
const { createTestStateSandbox } = require('./test-state-sandbox');
const { mergeJunitParts } = require('./junit-merge');
const { runFileToDeadline } = require('./shard-hang-diagnostics');

// Per-file deadline for a single test file inside a shard.
//
// 90s is 3-4x the historical max per-file wall time and is what makes a hang
// visible instead of waiting for the 20m job timeout (#1845, #1847).
const DEFAULT_FILE_TIMEOUT_MS = 90_000;

// Files that legitimately take longer than that because they install a package
// and run it, rather than because they hang.
//
// kernel-facade-contract runs a real `npm pack` + `npm install` of the tarball
// (internal subprocess timeouts alone allow 60s + 15s + 120s). On the Windows
// runner that crossed the 90s cap intermittently, killing a file that was still
// working and reddening CI on PRs that never touched it. The other three spawn
// a full external runner or a browser; they are slow by construction too.
//
// The cap stays 90s for everything else: this widens the deadline for exactly
// the paths that do install-scale work, and leaves the hang detection that
// #1847 added intact everywhere it was aimed.
const HEAVY_FILE_TIMEOUT_MS = 240_000;
const HEAVY_FILES = Object.freeze(new Set([
  'test/kernel-facade-contract.test.js',
  'test/external-action-gate-install.test.js',
  'test/v5-c5-external-conformance.test.js',
  'test/ui-conflict-triage-browser-smoke.test.js',
]));

function fileTimeoutMs(relativePath) {
  return HEAVY_FILES.has(relativePath) ? HEAVY_FILE_TIMEOUT_MS : DEFAULT_FILE_TIMEOUT_MS;
}

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
  const stem = path.basename(reportPath, path.extname(reportPath));
  return path.join(path.dirname(reportPath), `${stem}-failures.json`);
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

async function run(options) {
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
      const fileTimeout = fileTimeoutMs(file);
      // The state root is named on the starting line rather than logged
      // separately: it adds no line to a 157-file shard, it tells a hung file's
      // investigator where that file's state actually lives, and it is what
      // makes "every file got its own root" observable from outside instead of
      // a property only the source can attest to (#2032).
      console.log(`[shard ${options.shard}/${options.total}] starting ${index + 1}/${selected.files.length}: ${file} at ${startedAt} state-root ${sandbox.stateRoot}`);
      let result;
      try {
        result = await runFileToDeadline({
          cwd: REPO_ROOT,
          file,
          partPath,
          concurrency: options.concurrency,
          env: sandbox.environment,
          timeoutMs: fileTimeout,
          shard: options.shard,
        });
      } finally {
        sandbox.cleanup();
      }

      if (result.error) throw result.error;
      if (result.timedOut) {
        const elapsed = ((Date.now() - startedMs) / 1000).toFixed(3);
        const limitSeconds = (fileTimeout / 1000).toFixed(0);
        // The process tree printed above this line is the diagnostic #2814
        // asked for; the verdict below is unchanged from #1847.
        console.error(`[shard ${options.shard}/${options.total}] file ${file} timed out after ${limitSeconds}s (elapsed ${elapsed}s, signal ${result.signal || 'SIGTERM'}) — killed hanging file, see #1847 and #2814`);
        overallStatus = 1;
        failedFiles.push({ file, status: 'timeout' });
        // Leave a minimal JUnit entry so the merged report shows the hang
        // as a failure instead of silently dropping the file. Written with
        // exclusive create plus rename: a check-then-act on a rival-owned path
        // would lose to a test process still flushing its junit part, and the
        // fallback below (CodeQL js/file-system-race) must never erase the
        // child's own report. Rename is atomic on the same volume.
        try {
          const safe = file.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;');
          const payload = `<?xml version="1.0" encoding="utf-8"?>\n<testsuites>\n<testsuite name="${safe}" tests="1" failures="1" errors="0" skipped="0" time="${limitSeconds}.000"><testcase name="shard timeout (${limitSeconds}s) — file hung" classname="shard"><failure message="file hung and was killed after ${limitSeconds}s">File ${safe} did not exit within ${limitSeconds}s (likely CDP/browser hang, see #1847). Check the preceding [shard] starting log and the streamed reporter output above it.</failure></testcase></testsuite>\n</testsuites>\n`;
          let existing = null;
          try {
            existing = fs.readFileSync(partPath, 'utf8');
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          if (existing === null || existing.trim().length === 0) {
            const dir = path.dirname(partPath);
            const tmpPath = path.join(dir, `.${path.basename(partPath)}.${process.pid}.tmp`);
            const fd = fs.openSync(tmpPath, 'wx', 0o600);
            try {
              fs.writeFileSync(fd, payload);
            } finally {
              fs.closeSync(fd);
            }
            try {
              fs.linkSync(tmpPath, partPath);
            } catch (error) {
              if (error.code !== 'EEXIST') throw error;
            } finally {
              fs.rmSync(tmpPath, { force: true });
            }
          }
        } catch { /* ignore */ }
        continue;
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

// JUnit parsing/merging lives in scripts/junit-merge.js (#2212) and the
// per-file deadline plus its hang diagnostic in scripts/shard-hang-diagnostics.js
// (#2814); run() below keeps process orchestration, shard selection and exit
// codes only. That split is also why it is now async: the deadline must be able
// to look at the child while it is still alive.

if (require.main === module) {
  try {
    // Exit code 2 for a rejected run matches the synchronous version's
    // behaviour, and parseArgs still fails synchronously before any child starts.
    run(parseArgs(process.argv.slice(2))).then(
      (code) => { process.exitCode = code; },
      (error) => { console.error(error.message); process.exitCode = 2; },
    );
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}

module.exports = {
  DEFAULT_FILE_TIMEOUT_MS,
  HEAVY_FILE_TIMEOUT_MS,
  HEAVY_FILES,
  defaultReportPath,
  failuresSidecarPath,
  fileTimeoutMs,
  loadSelection,
  mergeJunitParts,
  parseArgs,
  run,
};
