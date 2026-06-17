const test = require('node:test');
const assert = require('node:assert/strict');
const CLI = require('../cli');

function createCli() {
  return new CLI({ kernel: { noLoad: true, loadPlugins: false } });
}

function turkishCommand(cli, input) {
  return cli.parse(input).command;
}

test('CLI parse maps English learn and teach aliases to the Turkish teach command', () => {
  const cli = createCli();
  const teachCommand = turkishCommand(cli, '\u00f6\u011fret: K\u00f6pek hayvand\u0131r');

  assert.deepStrictEqual(cli.parse('learn: cats are animals'), { command: teachCommand, args: 'cats are animals' });
  assert.deepStrictEqual(cli.parse('teach: cats are animals'), { command: teachCommand, args: 'cats are animals' });
});

test('CLI parse maps English ask and why aliases', () => {
  const cli = createCli();
  assert.deepStrictEqual(cli.parse('ask: cat nedir'), { command: 'sor', args: 'cat nedir' });
  assert.deepStrictEqual(cli.parse('why: tavuk'), { command: 'neden', args: 'tavuk' });
});

test('CLI parse maps English compare, verify, and upload aliases', () => {
  const cli = createCli();
  const compareCommand = turkishCommand(cli, 'tavuk ile yumurta aras\u0131nda kar\u015f\u0131la\u015ft\u0131r');
  const uploadCommand = turkishCommand(cli, 'y\u00fckle: bilgi.txt');

  assert.deepStrictEqual(cli.parse('compare: tavuk | yumurta'), { command: compareCommand, args: 'tavuk|yumurta' });
  assert.deepStrictEqual(cli.parse('compare: tavuk vs yumurta'), { command: compareCommand, args: 'tavuk|yumurta' });
  assert.deepStrictEqual(cli.parse('verify: kedi bitkidir'), { command: 'verify', args: 'kedi bitkidir' });
  assert.deepStrictEqual(cli.parse('upload: notes.txt'), { command: uploadCommand, args: 'notes.txt' });
});

test('CLI help text advertises English-first aliases while preserving Turkish compatibility', () => {
  const cli = createCli();
  const helpCommand = turkishCommand(cli, 'yard\u0131m');
  const output = cli.execute(helpCommand, '');

  assert.match(output, /English-first aliases:/);
  assert.match(output, /learn: cats are animals/);
  assert.match(output, /verify: kedi bitkidir/);
  assert.match(output, /Turkish compatibility aliases:/);
  assert.match(output, /kedi balik yer/);
});
