'use strict';

/**
 * #3043: `decay_lambda` and `prune_threshold` were hardcoded in
 * `huqan-core`'s `Graph::new()`, and `prune` only removed isolated nodes --
 * weakly linked stale nodes never left, so a graph grew without bound. This
 * pins the three fixes:
 *
 *   1. the thresholds are configurable at runtime (`config` command),
 *   2. `optimize`/`prune` return a receipt naming what was removed and why,
 *   3. a connected but weak node can be pruned when a policy threshold is set,
 *      without changing the isolated-only default.
 *
 * If the Rust binary is absent these skip rather than pretend to pass.
 */

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'huqan-core', 'target', 'release', 'huqan-core');
const skip = fs.existsSync(BIN) ? false : 'huqan-core release binary not built';

function rustExec(commands) {
  return new Promise((resolve, reject) => {
    const proc = spawn(BIN, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', chunk => { stdout += chunk; });
    proc.stderr.on('data', chunk => { stderr += chunk; });
    proc.on('error', reject);
    proc.on('close', code => {
      if (code !== 0) return reject(new Error(`huqan-core exit ${code}: ${stderr}`));
      resolve(stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line)));
    });
    proc.stdin.end(commands.map(command => JSON.stringify(command)).join('\n'));
  });
}

const EDGE = { cmd: 'add_edge', from: 'a', to: 'b', relation: 'tür', weight: 0.05 };

describe('#3043 configurable thresholds and receipted prune', { skip }, () => {
  it('config reports the thresholds it applies, and stats reflects them', async () => {
    const res = await rustExec([
      { cmd: 'config', decayLambda: 0.2, pruneThreshold: 0.4, connectedWeakThreshold: 0.3 },
      { cmd: 'stats' },
    ]);
    assert.strictEqual(res[0].ok, true);
    assert.strictEqual(res[0].config.decay_lambda, 0.2);
    assert.strictEqual(res[0].config.prune_threshold, 0.4);
    assert.strictEqual(res[0].config.connected_weak_threshold, 0.3);
    assert.strictEqual(res[1].stats.prune_threshold, 0.4);
    assert.strictEqual(res[1].stats.connected_weak_threshold, 0.3);
  });

  it('a custom prune threshold governs edge removal, and the receipt names it', async () => {
    const res = await rustExec([
      { cmd: 'add_node', id: 'a', label: 'a' },
      { cmd: 'add_node', id: 'b', label: 'b' },
      EDGE,
      { cmd: 'prune', threshold: 0.5 },
    ]);
    const prune = res[3];
    assert.strictEqual(prune.ok, true);
    assert.strictEqual(prune.pruned, 1, 'the 0.05-weight edge must prune at threshold 0.5');
    assert.strictEqual(prune.receipt.kind, 'prune');
    assert.strictEqual(prune.receipt.threshold, 0.5);
    assert.strictEqual(prune.receipt.prunedEdges, 1);
  });

  it('prune with a low threshold keeps the edge it should not remove', async () => {
    const res = await rustExec([
      { cmd: 'add_node', id: 'a', label: 'a' },
      { cmd: 'add_node', id: 'b', label: 'b' },
      EDGE,
      { cmd: 'prune', threshold: 0.01 },
    ]);
    assert.strictEqual(res[3].pruned, 0);
  });

  it('by default a connected weak node is NOT removed (no behaviour change)', async () => {
    const res = await rustExec([
      { cmd: 'add_node', id: 'a', label: 'a', weight: 0.001 },
      { cmd: 'add_node', id: 'b', label: 'b' },
      EDGE,
      { cmd: 'optimize' },
    ]);
    const optimize = res[3];
    assert.strictEqual(optimize.ok, true);
    assert.strictEqual(optimize.removed_nodes, 0, 'connected nodes stay by default');
    assert.strictEqual(optimize.receipt.removedConnectedWeak, 0);
  });

  it('a connectedWeakThreshold removes a connected weak node and receipted it', async () => {
    const res = await rustExec([
      { cmd: 'add_node', id: 'a', label: 'a' },
      { cmd: 'add_node', id: 'b', label: 'b' },
      EDGE,
      { cmd: 'optimize', connectedWeakThreshold: 0.9 },
    ]);
    const optimize = res[3];
    assert.strictEqual(optimize.ok, true);
    assert.ok(optimize.removed_nodes >= 1, 'a weak linked node must be removable');
    assert.strictEqual(optimize.receipt.kind, 'prune');
    assert.strictEqual(optimize.receipt.connectedWeakThreshold, 0.9);
    assert.ok(optimize.receipt.removedConnectedWeak >= 1);
    assert.ok(
      optimize.receipt.nodes.some(n => n.connected === true),
      'the receipt must mark the removed node as connected',
    );
  });
});
