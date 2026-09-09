const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const CLI = require('../cli');

const CLI_PATH = path.join(__dirname, '..', 'cli.js');
const { runCliArgv } = CLI;

function runCli(args) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cli-argv-'));
  try {
    return spawnSync(process.execPath, [CLI_PATH, ...args], {
      cwd,
      input: '',
      encoding: 'utf8',
      timeout: 20000,
    });
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
}

describe('CLI argv one-shot execution', { concurrency: false }, () => {
  it('keeps a portable Node shebang on the package bin entrypoint', () => {
    const firstLine = fs.readFileSync(CLI_PATH, 'utf8').split(/\r?\n/, 1)[0];
    assert.strictEqual(firstLine, '#!/usr/bin/env node');
  });

  it('keeps the no-argument invocation as the interactive REPL', () => {
    const result = runCli([]);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /HUQAN - talk, teach and ask in natural language/);
    assert.match(result.stdout, /axiom> /);
  });

  it('prints help without opening the REPL', () => {
    const result = runCli(['--help']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /HUQAN commands:/);
    assert.doesNotMatch(result.stdout, /axiom> /);
  });

  it('prints the package version without opening the REPL', () => {
    const result = runCli(['--version']);
    assert.strictEqual(result.status, 0);
    assert.strictEqual(result.stdout.trim(), require('../package.json').version);
    assert.doesNotMatch(result.stdout, /axiom> /);
  });

  it('executes a synchronous read command once', () => {
    const result = runCli(['durum']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Status:/);
    assert.doesNotMatch(result.stdout, /HUQAN - talk, teach and ask in natural language/);
  });

  it('joins argv and executes a parsed command once', () => {
    const result = runCli(['verify:', 'kedi', 'bitkidir']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Verify:/);
    assert.doesNotMatch(result.stdout, /axiom> /);
  });

  it('uses exit 2 for an unknown command or option', () => {
    const command = runCli(['frobnicate']);
    assert.strictEqual(command.status, 2);
    assert.match(command.stderr, /Unknown command:/);

    const option = runCli(['--frobnicate']);
    assert.strictEqual(option.status, 2);
    assert.match(option.stderr, /Unknown option:/);
  });

  // review_required is 5 in the one exit-code table; plain text used to say 3
  // for the same outcome --json reported as 5 (#1995).
  it('uses the review_required code when the command requires review', () => {
    const result = runCli(['learn:', 'cats', 'are', 'animals']);
    assert.strictEqual(result.status, 5);
    assert.match(result.stdout, /requires review/);
  });

  it('persists through the one-shot kaydet command', () => {
    const result = runCli(['kaydet']);
    assert.strictEqual(result.status, 0);
    assert.match(result.stdout, /Memory saved\./);
    assert.doesNotMatch(result.stdout, /Unknown command/);
  });

  it('can surface friendly REPL failures as structured argv errors', () => {
    const cli = new CLI({
      kernel: {
        noLoad: true,
        loadPlugins: false,
        useSQLite: false,
        memoryStoreUseSQLite: false,
      },
    });
    try {
      assert.throws(
        () => cli.execute('yükle', 'missing-file.txt', { gateResult: null, throwOnError: true }),
        /Could not read file/
      );
    } finally {
      cli.agent?.storage?.close?.();
      cli.kernel?.graph?.close?.();
      cli.kernel?.memory?.close?.();
    }
  });

  // failed is 8 in the one exit-code table; the same throw used to leave 1 in
  // plain text and 8 under --json, so a script's meaning changed with a
  // display flag (#1995).
  it('uses the failed code when command execution throws', () => {
    const result = runCli(['restore:', 'missing-backup']);
    assert.strictEqual(result.status, 8);
    assert.match(result.stderr, /Command error:/);
  });

  it('awaits delayed async output before returning success', async () => {
    const stdout = [];
    let resolved = false;
    const cli = {
      parse: () => ({ command: 'async-command', args: 'payload' }),
      _evaluateCliGate: () => null,
      execute: () => new Promise(resolve => {
        setTimeout(() => {
          resolved = true;
          resolve('async complete');
        }, 25);
      }),
    };

    const result = await runCliArgv(['async-command'], {
      cli,
      stdout: value => stdout.push(value),
    });

    assert.strictEqual(resolved, true);
    assert.strictEqual(result.exitCode, 0);
    assert.deepStrictEqual(stdout, ['async complete']);
  });

  it('maps a rejected async command to the failed code', async () => {
    const stderr = [];
    const cli = {
      parse: () => ({ command: 'async-command', args: '' }),
      _evaluateCliGate: () => null,
      execute: async () => {
        throw new Error('async failure');
      },
    };

    const result = await runCliArgv(['async-command'], {
      cli,
      stderr: value => stderr.push(value),
    });

    assert.strictEqual(result.exitCode, 8, 'failed is 8 in both modes (#1995)');
    assert.deepStrictEqual(stderr, ['Command error: async failure']);
  });

  it('uses the structured gate decision instead of output wording', async () => {
    const stdout = [];
    const cli = {
      parse: () => ({ command: 'guarded', args: '' }),
      _evaluateCliGate: () => ({ canExecute: false, decision: 'review', reason: 'approval_required' }),
      _formatCliGateMessage: () => 'approval required',
      execute: () => {
        throw new Error('guarded command must not execute');
      },
    };

    const result = await runCliArgv(['guarded'], {
      cli,
      stdout: value => stdout.push(value),
    });

    assert.strictEqual(result.exitCode, 5, 'review_required is 5 in both modes (#1995)');
    assert.strictEqual(result.decision, 'review');
    assert.deepStrictEqual(stdout, ['approval required']);
  });
});

describe('CLI exit code parity between output modes (#1995)', () => {
  function failing() {
    return {
      // A workflowId in both modes: without one, --json short-circuits to
      // capability_not_available before reaching the gate, and the two runs
      // would be comparing different branches rather than the same outcome.
      parse: () => ({ command: 'async-command', args: '', workflowId: 'wf-async' }),
      _evaluateCliGate: () => null,
      execute: async () => { throw new Error('async failure'); },
    };
  }

  function reviewed() {
    return {
      parse: () => ({ command: 'guarded', args: '', workflowId: 'wf-guarded' }),
      _evaluateCliGate: () => ({ canExecute: false, decision: 'review', reason: 'approval_required' }),
      _formatCliGateMessage: () => 'approval required',
      execute: () => { throw new Error('guarded command must not execute'); },
    };
  }

  // The defect: the same outcome left a different exit code depending only on
  // a display flag, so a script's meaning changed with --json.
  for (const [label, makeCli, argv] of [
    ['a failure', failing, ['async-command']],
    ['a review', reviewed, ['guarded']],
  ]) {
    it(`reports ${label} with the same code in both modes`, async () => {
      const plain = await runCliArgv(argv, { cli: makeCli(), stdout: () => {}, stderr: () => {} });
      const json = await runCliArgv([...argv, '--json'], { cli: makeCli(), stdout: () => {}, stderr: () => {} });

      assert.strictEqual(
        plain.exitCode,
        json.exitCode,
        `${label}: plain text exited ${plain.exitCode} while --json exited ${json.exitCode}`,
      );
    });
  }

  // Not parity, and deliberately so: plain text opens the REPL, which is a
  // successful start, while --json has no REPL and reports INVALID_INPUT.
  it('keeps the no-argument paths apart, because their outcomes differ', async () => {
    const plain = await runCliArgv([], { cli: failing(), stdout: () => {}, stderr: () => {} });
    const json = await runCliArgv(['--json'], { cli: failing(), stdout: () => {}, stderr: () => {} });

    assert.strictEqual(plain.interactive, true);
    assert.strictEqual(plain.exitCode, 0);
    assert.strictEqual(json.interactive, false);
    assert.strictEqual(json.exitCode, 2);
  });
});
