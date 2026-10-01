'use strict';

const assert = require('node:assert/strict');
const { describe, it } = require('node:test');
const path = require('node:path');
const { derivePorts, diffPorts } = require('../scripts/generate-context-ports.js');
const { loadOwnership } = require('../scripts/check-module-boundary.js');
const { listSourceFiles, buildGraph } = require('../scripts/check-import-cycles.js');

const OWNERSHIP_PATH = path.join(__dirname, '..', 'scripts', 'context-ownership.json');
const IS_TEST = /(\.test\.js$|(^|\/)test\/|(^|\/)benchmarks\/|(^|\/)demo)/;

describe('published-port generator (#2446)', () => {
  it('derives a port for a cross-context import and not for a same-context one', () => {
    const ownership = {
      contexts: new Set(['Knowledge', 'Trust']),
      owners: {
        'a.js': { context: 'Knowledge' },
        'b.js': { context: 'Trust' },
        'c.js': { context: 'Knowledge' },
      },
      platform: {},
      unassigned: {},
      outOfScope: [],
    };
    const graph = new Map([['a.js', ['b.js', 'c.js']]]);
    const ports = derivePorts(ownership, graph);
    assert.deepEqual([...ports.keys()], ['b.js']);
    assert.deepEqual(ports.get('b.js'), { owner: 'Trust', consumers: ['Knowledge'] });
  });

  it('does not emit a port for a Platform target, which is a legacy edge instead', () => {
    const ownership = {
      contexts: new Set(['Knowledge']),
      owners: { 'a.js': { context: 'Knowledge' } },
      platform: { 'server.js': { kind: 'entry' }, 'lib/text-utils.js': { kind: 'infra' } },
      unassigned: {},
      outOfScope: [],
    };
    const graph = new Map([['a.js', ['server.js', 'lib/text-utils.js']]]);
    assert.deepEqual([...derivePorts(ownership, graph).keys()], []);
  });

  it('records Platform as the consumer when Platform imports a domain port', () => {
    const ownership = {
      contexts: new Set(['Trust']),
      owners: { 'lib/receipt.js': { context: 'Trust' } },
      platform: { 'server.js': { kind: 'entry' } },
      unassigned: {},
      outOfScope: [],
    };
    const graph = new Map([['server.js', ['lib/receipt.js']]]);
    assert.deepEqual(derivePorts(ownership, graph).get('lib/receipt.js').consumers, ['Platform']);
  });

  it('reports missing, stale, and drifting ports', () => {
    const derived = new Map([
      ['a.js', { owner: 'Trust', consumers: ['Knowledge'] }],
      ['b.js', { owner: 'Trust', consumers: ['Knowledge'] }],
    ]);
    const committed = {
      'b.js': { owner: 'Knowledge', consumers: ['Knowledge'] },
      'c.js': { owner: 'Trust', consumers: ['Knowledge'] },
    };
    const problems = diffPorts(derived, committed);
    assert.equal(problems.length, 3);
    const joined = problems.join('\n');
    assert.match(joined, /missing port: a\.js/);
    assert.match(joined, /owner drift: b\.js/);
    assert.match(joined, /stale port: c\.js/);
  });

  it('reproduces the committed publishedPorts from the live require graph', () => {
    const ownership = loadOwnership(OWNERSHIP_PATH);
    const all = listSourceFiles();
    const graph = buildGraph(all, all.filter((file) => !IS_TEST.test(file)));
    const problems = diffPorts(derivePorts(ownership, graph), ownership.publishedPorts || {});
    assert.deepEqual(problems, []);
  });
});
