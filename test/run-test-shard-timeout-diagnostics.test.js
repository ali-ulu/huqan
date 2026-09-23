'use strict';

// #2814: on 2026-09-23 four hangs across three PRs each cost a full CI cycle and
// the shard log could not say where any of them stopped -- the junit reporter
// writes when a file finishes, which is the one thing a hanging file never does.
// These tests pin both halves of the fix: the streaming reporter pair the child
// is started with, and the per-file deadline that reads and reports the child's
// process tree while the child is still alive.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_FILE_TIMEOUT_MS } = require('../scripts/run-test-shard');
const {
  KILL_GRACE_MS,
  collectDescendants,
  formatProcessTree,
  parseProcessTable,
  runFileToDeadline,
  testArgsFor,
} = require('../scripts/shard-hang-diagnostics');

// Attribute order in the arg list is what binds a destination to a reporter, so
// this is asserted as a sequence rather than as set membership.
describe('shard-hang-diagnostics child arguments (#2814)', () => {
  test('the deadlined run streams spec to the log and still writes junit', () => {
    const args = testArgsFor('test/ui-conflict-triage-browser-smoke.test.js', '/tmp/part-1.xml', 1);
    // The reporter block is indices 2-5: each destination follows its reporter.
    assert.deepEqual(args.slice(2, 6), [
      '--test-reporter=spec',
      '--test-reporter-destination=stdout',
      '--test-reporter=junit',
      '--test-reporter-destination=/tmp/part-1.xml',
    ]);
    // The junit half is what the merged report and the nightly alarm sidecar
    // read; losing it would trade one blind spot for another.
    assert.equal(args.at(-2), '--test-reporter-destination=/tmp/part-1.xml');
    assert.equal(args.at(-1), 'test/ui-conflict-triage-browser-smoke.test.js');
    assert.ok(args.includes('--test'));
    assert.ok(args.includes('--test-concurrency=1'));
  });

  test('the grace for a doomed child stays well inside the smallest deadline', () => {
    // If the grace could exceed the deadline, a file that ignores SIGTERM would
    // cost the shard more than the deadline it is supposed to bound.
    assert.ok(KILL_GRACE_MS < DEFAULT_FILE_TIMEOUT_MS, `${KILL_GRACE_MS} must be below ${DEFAULT_FILE_TIMEOUT_MS}`);
  });
});

describe('shard-hang-diagnostics process table (#2814)', () => {
  test('a POSIX ps table is parsed into pid/ppid rows', () => {
    const rows = parseProcessTable([
      '    1     0  12:34:56 /sbin/init',
      '  240       1  00:03 node --test test/ui-claim-workspace-browser-smoke.test.js',
      '  241    240  00:02 /usr/bin/google-chrome --headless=new --user-data-dir=/tmp/huqan-cdp-xyz',
      'this line is not a process',
      '',
    ].join('\n'));
    assert.deepEqual(rows, [
      { pid: 1, ppid: 0, elapsed: '12:34:56', command: '/sbin/init' },
      { pid: 240, ppid: 1, elapsed: '00:03', command: 'node --test test/ui-claim-workspace-browser-smoke.test.js' },
      { pid: 241, ppid: 240, elapsed: '00:02', command: '/usr/bin/google-chrome --headless=new --user-data-dir=/tmp/huqan-cdp-xyz' },
    ]);
  });

  // `ps` does not exist on Windows (ENOENT), so the Windows legs get their table
  // from PowerShell instead. A single-format parser would print no diagnostic at
  // all on exactly the matrix legs #2450 added.
  test('the Windows probe format is parsed too, and an empty command survives it', () => {
    const rows = parseProcessTable([
      '240|1|node.exe --test test/ui-command-policy-browser-smoke.test.js',
      '321|240|',
    ].join('\r\n'));
    assert.deepEqual(rows, [
      { pid: 240, ppid: 1, elapsed: null, command: 'node.exe --test test/ui-command-policy-browser-smoke.test.js' },
      { pid: 321, ppid: 240, elapsed: null, command: '' },
    ]);
  });
});

describe('shard-hang-diagnostics process tree (#2814)', () => {
  test('the tree shows which process outlived the file, at its depth', () => {
    const rows = [
      { pid: 240, ppid: 1, elapsed: '00:03', command: 'node --test test/x.test.js' },
      { pid: 241, ppid: 240, elapsed: '00:02', command: '/usr/bin/google-chrome --headless=new' },
      { pid: 242, ppid: 241, elapsed: '00:02', command: '/usr/bin/google-chrome --type=renderer' },
      { pid: 9, ppid: 1, elapsed: '00:00', command: '/sbin/init' },
    ];
    const lines = formatProcessTree(rows, 240);
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^pid 241 ppid 240 etime 00:02 /);
    assert.match(lines[1], /^ {2}pid 242 ppid 241 /);
    assert.deepEqual(
      collectDescendants(rows, 240).map(({ row, depth }) => [row.pid, depth]),
      [[241, 0], [242, 1]],
    );
    assert.equal(lines.some(line => line.includes('sbin/init')), false, 'a sibling of the child is not its descendant');
  });

  test('a reaped root yields no tree instead of a wrong one', () => {
    // This is the state the old synchronous deadline left behind: it looked at a
    // pid whose children had already been reparented, so anything read then
    // belongs to some other process.
    const rows = [{ pid: 555, ppid: 1, elapsed: '00:01', command: 'node' }];
    assert.deepEqual(formatProcessTree(rows, 240), []);
    assert.deepEqual(collectDescendants(rows, 240), []);
  });

  test('a runaway tree is bounded so the evidence cannot flood the log', () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      pid: 1000 + index,
      ppid: index === 0 ? 240 : 999 + index,
      elapsed: '00:01',
      command: 'x'.repeat(300),
    }));
    const lines = formatProcessTree(rows, 240, { maxRows: 5, maxCommand: 40 });
    assert.equal(lines.length, 5);
    for (const line of lines) assert.ok(line.length < 100, `unbounded line: ${line}`);
  });
});

// The tests above prove the pieces. This one proves the behaviour #2814 is
// actually about: a file that never ends is reported as timed out, the process
// it left behind is named in the log, and that process does not outlive the
// deadline that killed the file.
describe('shard-hang-diagnostics on a file that never ends (#2814)', () => {
  test('a hanging file is timed out, reported with its tree, and leaves nothing behind', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-hang-2814-'));
    const fixture = path.join(dir, 'hangs-forever.test.js');
    const pidFile = path.join(dir, 'grandchild.pid');
    fs.writeFileSync(fixture, HANGING_FIXTURE);
    // The child runs `node --test` itself, so it must not inherit this run's
    // NODE_TEST_* context: with it, the nested runner decides it is being called
    // recursively and skips the file, which would quietly make this test assert
    // nothing (same trap as test/gate-state-sandbox.test.js).
    const inherited = { ...process.env };
    for (const name of Object.keys(inherited)) {
      if (name.startsWith('NODE_TEST')) delete inherited[name];
    }
    try {
      let outcome = null;
      const stderr = await captureStderr(async () => {
        outcome = await runFileToDeadline({
          cwd: path.join(__dirname, '..'),
          file: fixture,
          partPath: path.join(dir, 'part-1.xml'),
          concurrency: 1,
          env: { ...inherited, HUQAN_HANG_PID_FILE: pidFile },
          timeoutMs: 3_000,
          shard: 4,
        });
      });

      assert.equal(outcome.timedOut, true, 'a file that never ends must be reported as timed out');
      // The exit shape is platform-specific: POSIX reports a null status with
      // SIGTERM, Windows reports status 1 with no signal because it has none.
      // What has to hold on both is that the deadline ended the file, which is
      // why the runner branches on `timedOut` before it looks at either value.
      assert.ok(outcome.signal === null || outcome.signal === 'SIGTERM' || outcome.signal === 'SIGKILL',
        `unexpected exit signal ${outcome.signal}`);
      assert.ok(outcome.status === null || outcome.status === 1, `unexpected exit status ${outcome.status}`);
      assert.match(stderr, /\[shard 4\] process tree under pid \d+ when .*hangs-forever\.test\.js was killed/);

      const grandchild = await waitForPid(pidFile);
      assert.ok(grandchild > 0, 'the fixture never reported the process it spawned');
      // Named in the log while it was still alive: that is the whole reason the
      // deadline stopped being a spawnSync timeout.
      assert.match(stderr, new RegExp(`pid ${grandchild} ppid \\d+`), `tree did not name pid ${grandchild}:\n${stderr}`);
      await waitUntilGone(grandchild);
      assert.equal(isAlive(grandchild), false, 'the spawned process outlived the deadline that killed the file');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// A file that ends the way the 2026-09-23 hangs did: a test that never
// resolves, plus a process the file spawned that is meant to outlive it.
const HANGING_FIXTURE = [
  "const { spawn } = require('node:child_process');",
  "const fs = require('node:fs');",
  "const { test } = require('node:test');",
  "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
  'fs.writeFileSync(process.env.HUQAN_HANG_PID_FILE, String(child.pid));',
  "test('never resolves', async () => { await new Promise(() => {}); });",
  'setInterval(() => {}, 1000);',
].join('\n');

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The report lands on stderr, so that is what has to be read back. */
async function captureStderr(run) {
  const original = process.stderr.write;
  let captured = '';
  process.stderr.write = (chunk, ...rest) => {
    captured += String(chunk);
    return original.call(process.stderr, chunk, ...rest);
  };
  try {
    await run();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

async function waitForPid(pidFile, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fs.existsSync(pidFile)) {
      const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
      if (Number.isInteger(pid) && pid > 0) return pid;
    }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  return 0;
}

async function waitUntilGone(pid, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && isAlive(pid)) {
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

