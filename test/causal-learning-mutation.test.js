'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { episodeFromEvent, delta } = require('../lib/causal/causal-episode-contract');
const { LearnedCausalEngine } = require('../lib/causal/learned-causal-engine');
const { ACTIONS, NOOP, FRAME } = require('../lib/cognitive-lab-causal-world');

const PRE = { door: false, energized: true, jammed: false, nuisance: 1 };
function episodes(kind = 'controlled') {
  return Array.from({ length: 3 }, (_, i) => ['treatment', 'control'].map(arm => {
    const after = arm === 'treatment' ? { ...PRE, door: true } : PRE;
    return episodeFromEvent({ runId: `r${i}`, eventId: `r${i}-${arm}`, attemptId: `a${i}`, workspaceId: 'default', sequence: 1,
      type: 'verification', executionStatus: 'completed', outcomeStatus: 'verified', payload: { causalEpisode: {
        frameId: FRAME, preState: PRE, action: arm === 'treatment' ? ACTIONS[1] : NOOP, postState: after,
        effect: delta(PRE, after), observedAt: '2026-01-01T00:00:00Z', assignment: { kind, pairId: `p${i}`, arm, independenceKey: `g${i}` } } } },
    { workspaceId: 'default', frameId: FRAME });
  })).flat();
}
const QUERY = { workspaceId: 'default', frameId: FRAME, preState: PRE, action: ACTIONS[1] };
function mutant(relative, original, replacement) {
  const file = path.resolve(__dirname, '..', relative);
  const source = fs.readFileSync(file, 'utf8');
  assert.equal(source.split(original).length - 1, 1, 'mutation must have exactly one target');
  const compiledFile = file.replace(/\\.js$/, '.mutant.cjs');
  const compiled = new Module(compiledFile, module);
  compiled.filename = compiledFile;
  compiled.paths = module.paths;
  compiled._compile(source.replace(original, replacement), compiledFile);
  return compiled.exports;
}

test('removing the controlled-comparison gate breaks the observational-confounder acceptance assertion', () => {
  const input = episodes('observational');
  const assertion = Engine => assert.equal(new Engine({ episodes: input }).forward(QUERY).status, 'UNKNOWN');
  assertion(LearnedCausalEngine);
  const { LearnedCausalEngine: Mutant } = mutant('lib/causal/learned-causal-engine.js',
    "if (episode.assignment.kind !== 'controlled') continue;", 'if (false) continue;');
  assert.throws(() => assertion(Mutant), { code: 'ERR_ASSERTION' });
});

test('ignoring withdrawn sources breaks the support-invalidation acceptance assertion', () => {
  const input = episodes();
  const assertion = Engine => assert.equal(new Engine({ episodes: input, withdrawn: [input[0].sourceHash] }).forward(QUERY).status, 'UNKNOWN');
  assertion(LearnedCausalEngine);
  const { LearnedCausalEngine: Mutant } = mutant('lib/causal/learned-causal-engine.js',
    'this.episodes = episodes.filter(item => !revoked.has(item.sourceHash));', 'this.episodes = episodes;');
  assert.throws(() => assertion(Mutant), { code: 'ERR_ASSERTION' });
});

test('disabling the learned simulator caller breaks the real production-facade acceptance assertion', () => {
  // The constructor's Graph identity boundary is deliberately retained; this
  // probe calls the prototype only to isolate the exact delegation mutation.
  const { CausalSimulator } = require('../causalSimulator');
  const input = episodes();
  const host = { causalRuntime: { forward: query => new LearnedCausalEngine({ episodes: input }).forward({ ...QUERY, ...query }) } };
  const assertion = Simulator => assert.equal(Simulator.prototype.predictTransition.call(host, QUERY).postState.door, true);
  assertion(CausalSimulator);
  const { CausalSimulator: Mutant } = mutant('causalSimulator.js',
    'return this.causalRuntime.forward(input);', "return { status: 'UNKNOWN', postState: null };");
  assert.throws(() => assertion(Mutant), TypeError);
});
