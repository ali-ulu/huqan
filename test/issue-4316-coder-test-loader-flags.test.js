'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { TEST_REFUSALS, runDeclaredTest } = require('../lib/coder/test-execution');
const { evaluateCommandExec, COMMAND_EXEC_DECISIONS } = require('../lib/command-exec-gate');

// #4316 (audit, P1): the declared-test executor refused inline code
// (`-e`/`-p`/`--eval`) but not Node's module-loader flags, so
// `node --require <file> --test <test>` passed both the gate and the
// executor, and Node executed the caller's module before the test file
// under the Coder process's own permissions. `--import`, `--loader`,
// `--experimental-loader`, `--require-module` and a file `--test-reporter`
// reach the same code path.
//
// The gate cannot see this: it reads the command as text, and
// `node --require pre.js --test t.js` is a benign command as text -- the
// audit measured the gate returning ALLOW for it. So the flags have to be
// refused where the spawn happens, the same place #4073 put the executable
// allowlist. Related closed issues: #4073 (shell interpreter), #4239 (--run).
//
// #4342 completes the matrix: `=` variants of `--experimental-loader` and
// `--require-module` in the unit set, `--loader`/`--experimental-loader` in
// the isolated E2E, a `-r=` boundary pinned against real node, and a loader
// positive control.

function fakeSpawn(responses) {
  const calls = [];
  const spawn = (file, args, options) => {
    calls.push({ file, args, options });
    return responses[calls.length - 1] || { status: 0 };
  };
  spawn.calls = calls;
  return spawn;
}

const CODE_LOADING_COMMANDS = [
  'node --require /tmp/pre.js --test test/x.js',
  'node --require=/tmp/pre.js --test test/x.js',
  'node -r /tmp/pre.js --test test/x.js',
  'node --import /tmp/pre.mjs --test test/x.js',
  'node --import=/tmp/pre.mjs --test test/x.js',
  'node --loader /tmp/loader.mjs --test test/x.js',
  'node --loader=/tmp/loader.mjs --test test/x.js',
  'node --experimental-loader /tmp/loader.mjs --test test/x.js',
  'node --experimental-loader=/tmp/loader.mjs --test test/x.js',
  'node --require-module /tmp/pre.js --test test/x.js',
  'node --require-module=/tmp/pre.js --test test/x.js',
  'node --test-reporter /tmp/reporter.js --test test/x.js',
  'node --test-reporter=/tmp/reporter.js --test test/x.js',
];

describe('declared test refuses Node module-loader flags (#4316)', () => {
  it('refuses every code-loading flag before spawning, on a command the gate allows', () => {
    for (const command of CODE_LOADING_COMMANDS) {
      const spawn = fakeSpawn([]);

      // The gate's own verdict, so the test states the whole point: the gate
      // allows this text, so only the executor can stop it.
      assert.equal(evaluateCommandExec({ command }).decision, COMMAND_EXEC_DECISIONS.ALLOW, command);

      const result = runDeclaredTest({ test: { command }, root: '.', spawn });

      assert.equal(result.ran, false, `${command} ran`);
      assert.equal(result.reason, TEST_REFUSALS.TEST_COMMAND_CODE_LOADING_FLAG, command);
      assert.equal(spawn.calls.length, 0, `${command} spawned`);
    }
  });

  it('names the offending flag in the refusal', () => {
    const result = runDeclaredTest({
      test: { command: 'node --require /tmp/pre.js --test test/x.js' },
      root: '.',
      spawn: fakeSpawn([]),
    });

    assert.equal(result.flag, '--require');
  });

  it('pins the short-flag boundary: -r= is Node-invalid, not a guess the denylist makes', () => {
    // The denylist compares `-r` as a whole token on purpose: `-rx` or
    // `-r=x` is not a loader invocation Node accepts (node v22.22 exits
    // "bad option" before any file is read; the isolated E2E below pins
    // the same on the CI matrix), and refusing a longer short flag
    // would be a guess. So the executor hands the token to node and
    // node's own rejection is the boundary; the E2E pins that no module
    // executes on it. This unit test keeps the pass-through visible so a
    // future tightening is a deliberate change to the comment, not a
    // silent one.
    const spawn = fakeSpawn([{ status: 1 }]);
    const result = runDeclaredTest({
      test: { command: 'node -r=/tmp/pre.js --test test/x.js' },
      root: '.',
      spawn,
    });

    assert.equal(result.ran, true);
    assert.equal(result.ok, false);
    assert.deepEqual(spawn.calls[0].args[0], '-r=/tmp/pre.js');
  });

  it('still runs a declared test command with no code-loading flag', () => {
    const spawn = fakeSpawn([{ status: 0 }]);
    const result = runDeclaredTest({ test: { command: 'node --test test/x.js' }, root: '.', spawn });

    assert.equal(result.ran, true);
    assert.equal(result.ok, true);
    assert.deepEqual(spawn.calls[0].args, ['--test', 'test/x.js']);
  });

  it('leaves an unrelated test flag alone rather than switching to a strict allowlist', () => {
    // The rule is a denylist of code-loading flags, not "only --test may
    // appear": a flag Node accepts and that loads no caller code is still
    // passed through, so the fix does not over-block declared tests.
    const spawn = fakeSpawn([{ status: 0 }]);
    const result = runDeclaredTest({
      test: { command: 'node --test --test-concurrency=1 test/x.js' },
      root: '.',
      spawn,
    });

    assert.equal(result.ran, true);
    assert.equal(spawn.calls.length, 1);
  });

  it('keeps the inline-code refusal unchanged', () => {
    for (const command of ['node -e 0', 'node --eval=1', 'node -p 1+1']) {
      const result = runDeclaredTest({ test: { command }, root: '.', spawn: fakeSpawn([]) });
      assert.equal(result.ran, false, `${command} ran`);
      assert.equal(result.reason, TEST_REFUSALS.TEST_COMMAND_INLINE_CODE, command);
    }
  });

  it('keeps the gate ahead of the code-loading check', () => {
    const blocked = runDeclaredTest({ test: { command: 'rm -rf /' }, root: '.', spawn: fakeSpawn([]) });
    assert.equal(blocked.reason, TEST_REFUSALS.GATE_BLOCKED);
  });
});

describe('declared test code-loading flag end to end (#4316)', () => {
  function isolatedWorkspace() {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4316-ws-')));
    const outside = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-4316-out-')));
    fs.mkdirSync(path.join(root, 'test'));
    fs.writeFileSync(path.join(root, 'test', 'x.js'), "const { test } = require('node:test');\ntest('ok', () => {});\n");
    fs.writeFileSync(path.join(root, 'pre.js'),
      "require('node:fs').writeFileSync(process.env.HUQAN_4316_MARKER, 'PRELOAD RAN\\n');\n");
    fs.writeFileSync(path.join(root, 'pre.mjs'),
      "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.HUQAN_4316_MARKER, 'IMPORT RAN\\n');\n");
    // The loader fixture is also a working positive control: it writes the
    // marker at import time (a loader module is imported at startup) and
    // exports a pass-through hook so `--loader`/`--experimental-loader`
    // accept it and exit 0.
    fs.writeFileSync(path.join(root, 'loader.mjs'),
      "import { writeFileSync } from 'node:fs';\nwriteFileSync(process.env.HUQAN_4316_MARKER, 'LOADER RAN\\n');\nexport async function resolve(specifier, context, nextResolve) { return nextResolve(specifier, context); }\n");
    return { root, outside, cleanup: () => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); } };
  }

  it('runs no preload and writes no outside-workspace marker', () => {
    const { root, outside, cleanup } = isolatedWorkspace();
    const marker = path.join(outside, 'marker.txt');
    try {
      for (const [flag, module] of [
        ['--require', 'pre.js'],
        ['--import', 'pre.mjs'],
        // #4342: the loader paths are the same reach by other names; pin
        // them against a real spawn here, not only in the unit matrix.
        ['--loader', 'loader.mjs'],
        ['--experimental-loader', 'loader.mjs'],
      ]) {
        const result = runDeclaredTest({
          test: { command: `node ${flag} ${module} --test test/x.js` },
          root,
        });

        assert.equal(result.ran, false, `${flag} ran`);
        assert.equal(result.reason, TEST_REFUSALS.TEST_COMMAND_CODE_LOADING_FLAG, flag);
        assert.equal(fs.existsSync(marker), false, `${flag} wrote the outside marker`);
      }

      // Boundary the denylist deliberately leaves to Node: `-r=` is not a
      // loader invocation Node accepts, so the executor spawns and node
      // itself exits non-zero ("bad option") before any file is read. The
      // pin is fail-closed at the OS boundary: no preload, no marker.
      const boundary = runDeclaredTest({
        test: { command: 'node -r=pre.js --test test/x.js' },
        root,
      });
      assert.equal(boundary.ran, true);
      assert.equal(boundary.ok, false);
      assert.equal(fs.existsSync(marker), false, '-r= wrote the outside marker');

      // Positive control: the preload is functional, so the absent marker
      // above is the guard refusing the run and not a broken fixture. Running
      // the same argv directly bypasses the executor on purpose.
      // NODE_TEST_CONTEXT is dropped: this process is a `node --test` child,
      // and a grandchild that inherits it skips running test files entirely
      // ("run() is being called recursively"), which would make the control
      // lie. The control must see the plain environment a real declared-test
      // run sees.
      const { NODE_TEST_CONTEXT: _drop, ...controlEnv } = process.env;
      const control = childProcess.spawnSync('node', ['--require', './pre.js', '--test', 'test/x.js'], {
        cwd: root,
        env: { ...controlEnv, HUQAN_4316_MARKER: marker },
        encoding: 'utf8',
      });
      assert.equal(control.status, 0, control.stderr);
      assert.equal(fs.existsSync(marker), true);

      // Same proof for the loader fixture: node itself loads it and its
      // top-level write runs, so the absent marker above is the guard and
      // not a broken fixture. (Node still accepts --experimental-loader on
      // v22/v24; it warns, and the warning does not fail the run.)
      fs.rmSync(marker, { force: true });
      const loaderControl = childProcess.spawnSync('node', ['--experimental-loader', './loader.mjs', '--test', 'test/x.js'], {
        cwd: root,
        env: { ...controlEnv, HUQAN_4316_MARKER: marker },
        encoding: 'utf8',
      });
      assert.equal(loaderControl.status, 0, loaderControl.stderr);
      assert.equal(fs.existsSync(marker), true, loaderControl.stderr);
    } finally {
      cleanup();
    }
  });

  it('still runs a real declared test that loads no caller code', () => {
    const { root, cleanup } = isolatedWorkspace();
    try {
      const result = runDeclaredTest({ test: { command: 'node --test test/x.js' }, root });
      assert.equal(result.ran, true);
      assert.equal(result.ok, true);
    } finally {
      cleanup();
    }
  });
});
