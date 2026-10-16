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

  assert.deepStrictEqual(cli.parse('learn: cats are animals'), { command: teachCommand, args: 'cats are animals', workflowId: 'learn-review' });
  assert.deepStrictEqual(cli.parse('teach: cats are animals'), { command: teachCommand, args: 'cats are animals', workflowId: 'learn-review' });
});

test('CLI parse maps English ask and why aliases', () => {
  const cli = createCli();
  assert.deepStrictEqual(cli.parse('ask: cat nedir'), { command: 'sor', args: 'cat nedir', workflowId: 'ask' });
  assert.deepStrictEqual(cli.parse('why: tavuk'), { command: 'neden', args: 'tavuk', workflowId: 'reason' });
});

test('CLI parse maps English compare, verify, and upload aliases', () => {
  const cli = createCli();
  const compareCommand = turkishCommand(cli, 'tavuk ile yumurta aras\u0131nda kar\u015f\u0131la\u015ft\u0131r');
  const uploadCommand = turkishCommand(cli, 'y\u00fckle: bilgi.txt');

  assert.deepStrictEqual(cli.parse('compare: tavuk | yumurta'), { command: compareCommand, args: 'tavuk|yumurta', workflowId: 'compare' });
  assert.deepStrictEqual(cli.parse('compare: tavuk vs yumurta'), { command: compareCommand, args: 'tavuk|yumurta', workflowId: 'compare' });
  assert.deepStrictEqual(cli.parse('verify: kedi bitkidir'), { command: 'verify', args: 'kedi bitkidir', workflowId: 'verify' });
  assert.deepStrictEqual(cli.parse('upload: notes.txt'), { command: uploadCommand, args: 'notes.txt', workflowId: 'learn-review' });
});

test('CLI help text is English-first and still names the Turkish spellings', () => {
  const cli = createCli();
  const helpCommand = turkishCommand(cli, 'yard\u0131m');
  const output = cli.execute(helpCommand, '');

  assert.match(output, /"learn: cats are animals" -> learn a fact into the graph/);
  assert.match(output, /"status" -> system status/);
  assert.match(output, /"dream" -> generate ranked hypotheses/);
  assert.match(output, /"agent: <goal>" -> run the agent loop/);
  assert.match(output, /Turkish spellings are accepted permanently/);
  assert.match(output, /\u00f6\u011fret/);
});

test('the help text no longer leads with a Turkish example', () => {
  // The line every new user read first used to be `"kedi balik yer" -> I learn
  // a fact` on an English-positioned product.
  const cli = createCli();
  const output = cli.execute(turkishCommand(cli, 'yard\u0131m'), '');

  assert.doesNotMatch(output, /kedi balik yer/);
  assert.doesNotMatch(output, /tavuk mu yumurta mi/);
});

// RFC-001 decision 7: the reader accepts both spellings, permanently. Every
// Turkish command that had no English spelling gained one; none lost its own.
const SPELLING_PAIRS = [
  ['status', 'durum'],
  ['dream', 'r\u00fcya'],
  ['save', 'kaydet'],
  ['consolidate', 'birle\u015ftir'],
  ['hello', 'merhaba'],
];

for (const [english, turkish] of SPELLING_PAIRS) {
  test(`"${english}" and its Turkish spelling dispatch to the same command`, () => {
    const cli = createCli();

    assert.equal(cli.parse(english).command, cli.parse(turkish).command);
  });
}

test('think and stop thinking carry the same args as their Turkish spellings', () => {
  const cli = createCli();

  assert.deepStrictEqual(cli.parse('think'), cli.parse('otomatik d\u00fc\u015f\u00fcn'));
  assert.deepStrictEqual(cli.parse('stop thinking'), cli.parse('d\u00fc\u015f\u00fcnmeyi durdur'));
});

test('bare "why X" reaches cause analysis, like bare "neden X"', () => {
  // The `why:` prefix already existed; the prefixless form fell through to the
  // question heuristic and answered as an ask.
  const cli = createCli();

  assert.deepStrictEqual(cli.parse('why chicken'), cli.parse('neden chicken'));
  assert.equal(cli.parse('why chicken').workflowId, 'reason');
});

test('the agent: prefix matches the ajan: prefix', () => {
  const cli = createCli();

  assert.deepStrictEqual(cli.parse('agent: build a plan'), cli.parse('ajan: build a plan'));
});
