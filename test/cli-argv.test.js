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

  it('uses exit 3 when the command requires review', () => {
    const result = runCli(['learn:', 'cats', 'are', 'animals']);
    assert.strictEqual(result.status, 3);
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

  it('uses exit 1 when command execution throws', () => {
    const result = runCli(['restore:', 'missing-backup']);
    assert.strictEqual(result.status, 1);
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

  it('maps a rejected async command to exit 1', async () => {
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

    assert.strictEqual(result.exitCode, 1);
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

    assert.strictEqual(result.exitCode, 3);
    assert.strictEqual(result.decision, 'review');
    assert.deepStrictEqual(stdout, ['approval required']);
  });
});
