'use strict';

// The verify and llm-ask handlers render whatever the kernel returns. A
// verdict with no data, a non-numeric confidence or a non-array evidence list
// must still print a line instead of throwing (#1029).

const assert = require('node:assert/strict');
const test = require('node:test');

const { verifyCommand, llmAskCommand } = require('../lib/cli-knowledge-commands');

function cliWith(verifyResult, answer = 'Bilmiyorum') {
  return {
    kernel: {
      verify: () => verifyResult,
      ask: () => ({ data: { answer } }),
    },
    llm: { model: 'llama3' },
  };
}

test('verify prints unknown and n/a when the verdict carries no data', () => {
  assert.equal(verifyCommand(cliWith({}), 'x'), 'Verify: unknown (confidence: n/a)');
});

test('verify ignores a non-numeric confidence and a non-array evidence list', () => {
  const out = verifyCommand(cliWith({ data: { status: 'supported', confidence: 'high' }, evidence: 'not-a-list' }), 'x');
  assert.equal(out, 'Verify: supported (confidence: n/a)');
});

test('verify prints the first evidence line when there is one', () => {
  const out = verifyCommand(cliWith({ data: { status: 'supported', confidence: 0.5 }, evidence: [{ text: 'kanit' }] }), 'x');
  assert.equal(out, 'Verify: supported (confidence: 0.50)\nEvidence: kanit');
});

test('llm-ask prints unknown and n/a when the verdict carries no data', () => {
  const out = llmAskCommand(cliWith({}), 'soru');
  assert.equal(out.split('\n')[0], 'AXIOM dogrulamasi: unknown (guven: n/a)');
  assert.doesNotMatch(out, /\nAXIOM: /, 'an unknown answer is not printed');
  assert.match(out, /ollama run/);
});

test('llm-ask prints the answer, the evidence and a default risk label', () => {
  const verdict = {
    data: { status: 'contested', confidence: 0.25, risk: { manipulation: true, labels: [], score: 'x' } },
    evidence: [{ text: 'kanit' }],
  };
  const lines = llmAskCommand(cliWith(verdict, 'evet'), 'soru').split('\n');
  assert.deepEqual(lines.slice(0, 4), [
    'AXIOM dogrulamasi: contested (guven: 0.25)',
    'AXIOM: evet',
    'Kanit: kanit',
    'Risk: manipulation (skor: n/a)',
  ]);
});
