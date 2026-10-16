'use strict';

/**
 * Context-aware module boundary gate (#2446 Map/Publish/Enforce, Wiki design
 * decision v0.1 2026-09-25).
 *
 * Strictness is unchanged (every cross-module private call still fails); what
 * is new is that the gate reads the exhaustive ownership manifest: the failure
 * names the caller's context, and a caller with no recorded context fails with
 * an assignment instruction instead of a bare line number. The gate refuses to
 * guess the callee's file from the owner binding, refuses an ownership file
 * that names a domain context outside the five, and refuses Platform entries
 * without an infra/entry kind. v0.1: ports are file-level only, Platform
 * entrypoints need dated legacy edges from domain importers, and every
 * in-scope file without a manifest row fails coverage.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const {
  loadOwnership,
  ownerOf,
  describeCall,
  checkContextPorts,
  coverageStatus,
} = require('../scripts/check-module-boundary');

const OWNERSHIP_PATH = path.join(__dirname, '..', 'scripts', 'context-ownership.json');

describe('context-aware module boundary', () => {
  it('loads the map with the five contexts', () => {
    const ownership = loadOwnership(OWNERSHIP_PATH);
    assert.deepEqual([...ownership.contexts].sort(), [
      'AgentAction', 'Knowledge', 'Memory', 'Observability', 'Trust',
    ]);
  });

  it('resolves exact files and platform kinds from the manifest', () => {
    const ownership = loadOwnership(OWNERSHIP_PATH);
    assert.deepEqual(ownerOf('graph.js', ownership), { context: 'Knowledge', status: 'assigned' });
    assert.deepEqual(
      ownerOf('lib/receipt/canonical-receipt.js', ownership),
      { context: 'Trust', status: 'assigned' },
    );
    assert.deepEqual(
      ownerOf('lib/experience/journal.js', ownership),
      { context: 'Trust', status: 'assigned' },
    );
    assert.deepEqual(
      ownerOf('server.js', ownership),
      { context: 'Platform', status: 'entry' },
    );
    assert.deepEqual(
      ownerOf('lib/text-utils.js', ownership),
      { context: 'Platform', status: 'infra' },
    );
    assert.deepEqual(
      ownerOf('lib/some-future-module.js', ownership),
      { context: null, status: 'never-examined' },
    );
  });

  it('still reports resists and out-of-scope through synthetic ownership', () => {
    const ownership = {
      contexts: new Set(['Knowledge']),
      owners: {},
      platform: {},
      unassigned: { 'kernel.js': { status: 'resists' } },
      outOfScope: [{ prefix: 'scripts/', reason: 'tooling' }],
    };
    assert.deepEqual(ownerOf('kernel.js', ownership), { context: null, status: 'resists' });
    assert.deepEqual(ownerOf('scripts/x.js', ownership), { context: null, status: 'out-of-scope' });
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
    const ownership = {
      contexts: new Set(['Knowledge']),
      owners: {},
      platform: {},
      unassigned: {},
      outOfScope: [],
    };
    const message = describeCall(
      'lib/some-future-module.js',
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

  it('fails a file listed as both a domain owner and platform', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-ctx-')));
    const tmp = path.join(dir, 'ctx.json');
    fs.writeFileSync(tmp, JSON.stringify({
      contexts: ['Knowledge'],
      owners: { 'graph.js': { context: 'Knowledge', evidence: 'e' } },
      platform: { 'graph.js': { kind: 'entry', evidence: 'e' } },
      unassigned: {},
    }), 'utf8');
    assert.throws(() => loadOwnership(tmp), /graph\.js is listed in both owners and platform/);
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

describe('platform boundary (Wiki v0.1)', () => {
  const ownership = {
    contexts: new Set(['Knowledge', 'Trust', 'AgentAction']),
    owners: {
      'graph.js': { context: 'Knowledge' },
      'lib/receipt/receipt-chain.js': { context: 'Trust' },
    },
    platform: {
      'server.js': { kind: 'entry' },
      'lib/text-utils.js': { kind: 'infra' },
    },
    unassigned: {},
    outOfScope: [{ prefix: 'scripts/', reason: 'tooling' }],
    publishedPorts: {
      'lib/receipt/receipt-chain.js': { owner: 'Trust', consumers: ['Knowledge', 'Platform'] },
    },
    legacyEdges: {},
  };

  it('lets domain import Platform infra freely', () => {
    const graph = new Map([['graph.js', ['lib/text-utils.js']]]);
    assert.deepEqual(checkContextPorts(graph, ownership, '2026-09-28').problems, []);
  });

  it('lets Platform import published domain ports', () => {
    const graph = new Map([['server.js', ['lib/receipt/receipt-chain.js']]]);
    assert.deepEqual(checkContextPorts(graph, ownership, '2026-09-28').problems, []);
  });

  it('rejects domain imports of Platform entrypoints without a legacy edge', () => {
    const graph = new Map([['lib/receipt/receipt-chain.js', ['server.js']]]);
    assert.match(
      checkContextPorts(graph, ownership, '2026-09-28').problems[0],
      /Platform entrypoint/,
    );
  });

  it('allows a dated legacy edge into a Platform entrypoint', () => {
    const withLegacy = {
      ...ownership,
      legacyEdges: { 'graph.js>server.js': { reason: 'test legacy', reviewBy: '2026-12-31' } },
    };
    const graph = new Map([['graph.js', ['server.js']]]);
    assert.deepEqual(checkContextPorts(graph, withLegacy, '2026-09-28').problems, []);
  });

  it('rejects Platform entries without an infra/entry kind at load', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const tmp = path.join(fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-ctx-'))), 'ctx.json');
    fs.writeFileSync(tmp, JSON.stringify({
      contexts: ['Knowledge'],
      owners: {},
      platform: { 'server.js': { kind: 'composition' } },
      unassigned: {},
    }), 'utf8');
    assert.throws(() => loadOwnership(tmp), /unknown platform kind for server\.js/);
  });
});

describe('manifest coverage (#2446 Done-when negative)', () => {
  it('fails a file added without a manifest row', () => {
    const ownership = loadOwnership(OWNERSHIP_PATH);
    const { unmapped } = coverageStatus(ownership, ['lib/some-future-module.js', 'graph.js']);
    assert.deepEqual(unmapped, ['lib/some-future-module.js']);
  });

  it('skips out-of-scope tooling and test files', () => {
    const ownership = loadOwnership(OWNERSHIP_PATH);
    const { unmapped } = coverageStatus(
      ownership,
      ['scripts/check-module-boundary.js', 'examples/x.js', 'public/x.js', 'lib/x.test.js'],
    );
    assert.deepEqual(unmapped, []);
  });

  it('the committed manifest leaves nothing unmapped', () => {
    const { listSourceFiles } = require('../scripts/check-import-cycles.js');
    const ownership = loadOwnership(OWNERSHIP_PATH);
    const { unmapped } = coverageStatus(ownership, listSourceFiles());
    assert.deepEqual(unmapped, []);
  });

  it('treats a recorded resist as unmapped, not as covered', () => {
    const ownership = {
      contexts: new Set(['Knowledge']),
      owners: { 'graph.js': { context: 'Knowledge', evidence: 'e' } },
      platform: {},
      unassigned: { 'kernel.js': { status: 'resists' } },
      outOfScope: [],
    };
    const { unmapped } = coverageStatus(ownership, ['kernel.js', 'graph.js']);
    assert.deepEqual(unmapped, ['kernel.js']);
  });
});

/**
 * The helper tests above pin coverageStatus(); they cannot see what the CLI
 * actually prints. A gate that exits 1 for the right reason but prints the
 * wrong reason is a real defect (the unmapped branch once sat inside the
 * `ports.problems` block, so an unmapped file failed silently behind the
 * private-call footer). These run the gate as a subprocess and assert on both
 * the exit code and the message.
 *
 * The probe is a clean, already-assigned file dropped from a temp manifest:
 * unmapped, with zero private calls, so the unmapped branch is the only thing
 * that can fire.
 */
describe('module boundary gate CLI (#2446)', () => {
  const { spawnSync } = require('node:child_process');
  const fs = require('node:fs');
  const os = require('node:os');
  const GATE = path.join(__dirname, '..', 'scripts', 'check-module-boundary.js');
  const PROBE = 'lib/agent-action-decisions.js';

  function runGate(env = {}) {
    // The gate honors HUQAN_CONTEXT_OWNERSHIP to let the negative test point it
    // at a temp manifest. Inheriting the parent env here would leak that
    // override into the positive test too: whichever order the runner picks,
    // "stays green" would read the probe's stripped manifest and report
    // `FAIL unmapped: <PROBE>`. Start from a clean env and re-add the override
    // only when the caller asks for it.
    const base = { ...process.env };
    delete base.HUQAN_CONTEXT_OWNERSHIP;
    return spawnSync(process.execPath, [GATE], {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      env: { ...base, ...env },
    });
  }

  function manifestWithout(committed, file) {
    const { [file]: _dropped, ...owners } = committed.owners;
    return { ...committed, owners, contexts: [...committed.contexts] };
  }

  it('prints FAIL unmapped and exits 1 when an in-scope file has no manifest row', () => {
    const committed = JSON.parse(fs.readFileSync(OWNERSHIP_PATH, 'utf8'));
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-')));
    const tmp = path.join(dir, 'ctx.json');
    fs.writeFileSync(tmp, JSON.stringify(manifestWithout(committed, PROBE)), 'utf8');
    try {
      const result = runGate({ HUQAN_CONTEXT_OWNERSHIP: tmp });
      assert.equal(result.status, 1, `gate should fail; stderr: ${result.stderr}`);
      assert.match(result.stderr, new RegExp(`FAIL unmapped: ${PROBE.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
      assert.match(result.stderr, /assign it in context-ownership\.json/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('stays green against the committed manifest', () => {
    const result = runGate();
    assert.equal(result.status, 0, `gate should pass; stderr: ${result.stderr}`);
    assert.match(result.stdout, /0 unmapped/);
  });

  it('ignores an inherited HUQAN_CONTEXT_OWNERSHIP override when green', () => {
    const committed = JSON.parse(fs.readFileSync(OWNERSHIP_PATH, 'utf8'));
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-gate-leak-')));
    const tmp = path.join(dir, 'ctx.json');
    fs.writeFileSync(tmp, JSON.stringify(manifestWithout(committed, PROBE)), 'utf8');
    const previous = process.env.HUQAN_CONTEXT_OWNERSHIP;
    process.env.HUQAN_CONTEXT_OWNERSHIP = tmp;
    try {
      const result = runGate();
      assert.equal(result.status, 0, `an inherited override must not leak; stderr: ${result.stderr}`);
      assert.match(result.stdout, /0 unmapped/);
    } finally {
      if (previous === undefined) delete process.env.HUQAN_CONTEXT_OWNERSHIP;
      else process.env.HUQAN_CONTEXT_OWNERSHIP = previous;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
