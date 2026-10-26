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
  'node --require-module /tmp/pre.js --test test/x.js',
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
    return { root, outside, cleanup: () => { fs.rmSync(root, { recursive: true, force: true }); fs.rmSync(outside, { recursive: true, force: true }); } };
  }

  it('runs no preload and writes no outside-workspace marker', () => {
    const { root, outside, cleanup } = isolatedWorkspace();
    const marker = path.join(outside, 'marker.txt');
    try {
      for (const [flag, module] of [['--require', 'pre.js'], ['--import', 'pre.mjs']]) {
        const result = runDeclaredTest({
          test: { command: `node ${flag} ${module} --test test/x.js` },
          root,
        });

        assert.equal(result.ran, false, `${flag} ran`);
        assert.equal(result.reason, TEST_REFUSALS.TEST_COMMAND_CODE_LOADING_FLAG, flag);
        assert.equal(fs.existsSync(marker), false, `${flag} wrote the outside marker`);
      }

      // Positive control: the preload is functional, so the absent marker
      // above is the guard refusing the run and not a broken fixture. Running
      // the same argv directly bypasses the executor on purpose.
      const control = childProcess.spawnSync('node', ['--require', './pre.js', '--test', 'test/x.js'], {
        cwd: root,
        env: { ...process.env, HUQAN_4316_MARKER: marker },
        encoding: 'utf8',
      });
      assert.equal(control.status, 0, control.stderr);
      assert.equal(fs.existsSync(marker), true);
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
