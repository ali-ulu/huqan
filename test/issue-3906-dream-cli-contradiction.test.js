'use strict';

// #3906: `huqan dream` printed `undefined -> undefined` for the çelişki
// (contradiction) hypothesis because the CLI formatter read only `from`/`to`,
// while that hypothesis shape carries `node` + `targets[]`
// (lib/dream-hypothesis-finders.js appendContradictionHypotheses).

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');

const { dreamCommand } = require('../lib/cli-knowledge-commands');

const cli = (hypotheses) => ({ dream: { dream: () => hypotheses } });

describe('#3906 - dream CLI formatter shows contradiction hypotheses', () => {
  it('renders the çelişki node and targets instead of undefined', () => {
    const output = dreamCommand(cli([{
      type: 'çelişki',
      node: 'kedi',
      targets: ['hayvan [değil]', 'hayvan'],
      confidence: 0.8,
    }]), '', {}, 'rüya');

    assert.doesNotMatch(output, /undefined/);
    assert.match(output, /kedi/);
    assert.match(output, /hayvan \[değil\]/);
    assert.match(output, /hayvan/);
    assert.match(output, /çelişki/);
    assert.match(output, /0\.80/);
  });

  it('keeps the from -> to rendering for hypotheses that carry those fields', () => {
    const output = dreamCommand(cli([
      { from: 'kedi', to: 'köpek', type: 'benzerlik', confidence: 0.34 },
    ]), '', {}, 'rüya');

    assert.match(output, /kedi -> köpek \(benzerlik, guven: 0\.34\)/);
    assert.doesNotMatch(output, /undefined/);
  });

  it('renders a mixed list with one line per hypothesis', () => {
    const output = dreamCommand(cli([
      { type: 'çelişki', node: 'kedi', targets: ['hayvan [değil]', 'hayvan'], confidence: 0.8 },
      { from: 'kedi', to: 'köpek', type: 'vektör-benzerlik', confidence: 0.3 },
    ]), '', {}, 'rüya');

    assert.match(output, /^2 hipotez:/);
    assert.doesNotMatch(output, /undefined/);
    assert.equal(output.split('\n').length, 3);
  });
});
