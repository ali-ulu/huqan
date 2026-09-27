'use strict';

/**
 * Context-aware module boundary gate (#2446 Enforce).
 *
 * Strictness is unchanged (every cross-module private call still fails); what
 * is new is that the gate reads the ownership map: the failure names the
 * caller's context, and a caller with no recorded context fails with an
 * assignment instruction instead of a bare line number. The gate refuses to
 * guess the callee's file from the owner binding, and refuses an ownership
 * file that names a context outside the five.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  loadOwnership,
  ownerOf,
  describeCall,
  checkContextPorts,
} = require('../scripts/check-module-boundary');

const OWNERSHIP_PATH = path.join(__dirname, '..', 'scripts', 'context-ownership.json');

describe('context-aware module boundary', () => {
  it('loads the map with the five contexts', () => {
    const ownership = loadOwnership(OWNERSHIP_PATH);
    assert.deepEqual([...ownership.contexts].sort(), [
      'AgentAction', 'Knowledge', 'Memory', 'Observability', 'Trust',
    ]);
  });

  it('resolves exact files, directory prefixes, and resists entries', () => {
    const ownership = loadOwnership(OWNERSHIP_PATH);
    assert.deepEqual(ownerOf('graph.js', ownership), { context: 'Knowledge', status: 'assigned' });
    assert.deepEqual(
      ownerOf('lib/receipt/canonical-receipt.js', ownership),
      { context: 'Trust', status: 'assigned' },
    );
    assert.deepEqual(
      ownerOf('lib/experience/journal.js', ownership),
      { context: null, status: 'resists' },
    );
    assert.deepEqual(
      ownerOf('lib/some-future-module.js', ownership),
      { context: null, status: 'never-examined' },
    );
  });

  it('names the caller context instead of guessing the callee', () => {
    const ownership = loadOwnership(OWNERSHIP_PATH);
    const message = describeCall(
      'graph.js',
      { line: 9, call: 'graph._applyTemporalEdgeMetadata()' },
      ownership,
    );
    assert.match(message, /\(Knowledge\)/);
    assert.doesNotMatch(message, /Trust/);
  });

  it('tells an unassigned caller to get assigned first', () => {
    const ownership = loadOwnership(OWNERSHIP_PATH);
    const message = describeCall(
      'kernel.js',
      { line: 1, call: 'kernel._evaluateLearnAdmission()' },
      ownership,
    );
    assert.match(message, /no owning context recorded/);
    assert.match(message, /context-ownership\.json/);
  });

  it('fails closed on an unknown context rather than enforcing a typo', () => {
    const ownership = loadOwnership(OWNERSHIP_PATH);
    const tampered = {
      contexts: [...ownership.contexts],
      owners: { 'graph.js': { context: 'Knowlege', evidence: 'typo', status: 'assigned' } },
      unassigned: {},
    };
    const fs = require('node:fs');
    const os = require('node:os');
    const tmp = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-ctx-'))), 'ctx.json');
    fs.writeFileSync(tmp, JSON.stringify(tampered), 'utf8');
    assert.throws(() => loadOwnership(tmp), /unknown context for graph\.js/);
  });
});

describe('published context ports', () => {
  const ownership = {
    contexts: new Set(['Knowledge', 'Trust', 'AgentAction']),
    owners: {
      'graph.js': { context: 'Knowledge' },
      'lib/receipt/receipt-chain.js': { context: 'Trust' },
      'lib/verdict/action-verdict.js': { context: 'AgentAction' },
    },
    unassigned: {},
    publishedPorts: {
      'lib/verdict/action-verdict.js': { owner: 'AgentAction', consumers: ['Trust'] },
    },
    legacyEdges: {
      'graph.js>lib/receipt/receipt-chain.js': { reviewBy: '2026-12-31' },
    },
  };

  it('allows a declared port and a dated legacy edge', () => {
    const graph = new Map([
      ['lib/receipt/receipt-chain.js', ['lib/verdict/action-verdict.js']],
      ['graph.js', ['lib/receipt/receipt-chain.js']],
    ]);
    assert.deepEqual(checkContextPorts(graph, ownership, '2026-09-28').problems, []);
  });

  it('rejects a new cross-owner import without a published port', () => {
    const graph = new Map([['graph.js', ['lib/verdict/action-verdict.js']]]);
    assert.match(checkContextPorts(graph, ownership, '2026-09-28').problems[0], /unpublished/);
  });

  it('rejects expired and stale legacy exceptions', () => {
    const graph = new Map([['graph.js', ['lib/receipt/receipt-chain.js']]]);
    assert.match(checkContextPorts(graph, ownership, '2027-01-01').problems[0], /expired/);
    assert.match(checkContextPorts(new Map(), ownership, '2026-09-28').problems[0], /stale/);
  });
});
