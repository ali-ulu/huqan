'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const fc = require('fast-check');

const CLI = require('../../cli');
const { runCliArgv } = require('../../cli');

const cliSource = fs.readFileSync(path.join(__dirname, '..', '..', 'cli.js'), 'utf8');
const handlerStart = cliSource.indexOf('const CLI_COMMAND_HANDLERS');
const handlerEnd = cliSource.indexOf('\n}));', handlerStart);
assert.ok(handlerStart >= 0 && handlerEnd > handlerStart, 'CLI command registry must be discoverable');

const handlerBlock = cliSource.slice(handlerStart, handlerEnd);
const commands = [...handlerBlock.matchAll(/^\s*'([^']+)'\s*:/gm)].map((match) => match[1]);
assert.ok(commands.length > 20, 'expected the full CLI command registry');
assert.equal(new Set(commands).size, commands.length, 'CLI registry must not contain duplicate command keys');

const parserReceiver = {
  kernel: {
    normalizeWord: (value) => String(value),
    graph: { getNode: () => null },
  },
};

test('CLI fuzz: every command registered in cli.js survives edge-case text inputs', { timeout: 10000 }, () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...commands),
      fc.string({ maxLength: 512 }),
      (command, payload) => {
        const candidate = payload.length > 0 ? command + ': ' + payload : command;
        const parsed = CLI.prototype.parse.call(parserReceiver, candidate);
        assert.ok(parsed && typeof parsed === 'object');
        assert.equal(typeof parsed.command, 'string');
        assert.ok(Object.prototype.hasOwnProperty.call(parsed, 'args'));
      },
    ),
    { numRuns: Math.max(360, commands.length * 12) },
  );
});

test('CLI argv fuzz: arbitrary bounded argv cannot crash the cli.js entry point', { timeout: 15000 }, async () => {
  const fakeCli = {
    parse() {
      return { command: 'anlamadım', args: '', workflowId: null };
    },
    execute() {
      return 'help';
    },
    evaluateCliGate() {
      return { canExecute: false, decision: 'block', reason: 'fuzz' };
    },
  };
  const output = [];
  const reserved = new Set(['ingest', 'stop', 'lift', 'integrity']);
  const argvArb = fc.array(fc.string({ maxLength: 96 }), { maxLength: 10 })
    .filter((argv) => argv.length === 0 || !reserved.has(String(argv[0]).toLowerCase()));

  await fc.assert(
    fc.asyncProperty(argvArb, async (argv) => {
      const result = await runCliArgv(argv, {
        cli: fakeCli,
        stdout: (value) => output.push(value),
        stderr: (value) => output.push(value),
      });
      assert.ok(result && typeof result === 'object');
      assert.equal(Number.isInteger(result.exitCode), true);
    }),
    { numRuns: 220 },
  );
});
