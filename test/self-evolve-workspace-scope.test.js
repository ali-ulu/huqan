'use strict';

/**
 * #1189: selfEvolve() accepted an options object, never read a workspaceId from
 * it, and passed none to any collaborator. Every read ran against 'default', so
 * an operator running `evolve` on any other workspace got a well-formed success
 * object with every counter at zero — indistinguishable from "nothing here was
 * worth evolving".
 *
 * The reproduction below is the one from the issue: the same graph shape built
 * twice, differing only in the workspace it is written to. Before the fix that
 * produced dreams=10 in `default` and dreams=0 in `tenant-a`.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { after, test } = require('node:test');

const Kernel = require('../kernel');
const Dream = require('../dream');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-self-evolve-ws-'));

after(() => {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
});

const SHAPE = [
  ['kedi', 'hayvan'],
  ['kopek', 'hayvan'],
  ['kus', 'hayvan'],
  ['balik', 'hayvan'],
  ['hayvan', 'canli'],
];

let seq = 0;
function makeKernel() {
  seq += 1;
  return new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryPath: path.join(root, `k${seq}.json`),
  });
}

function buildShape(kernel, workspaceId, pairs = SHAPE) {
  for (const [from, to] of pairs) {
    kernel.graph.addNode(from, from, null, { workspaceId });
    kernel.graph.addNode(to, to, null, { workspaceId });
    kernel.graph.addEdge(from, to, 'tür', { workspaceId, strength: 0.8, confidence: 0.9, source: 'manual' });
  }
  return kernel;
}

test('#1189 selfEvolve evolves a non-default workspace, not silently nothing', () => {
  const inDefault = buildShape(makeKernel(), 'default').selfEvolve({ workspaceId: 'default' });
  const inTenant = buildShape(makeKernel(), 'tenant-a').selfEvolve({ workspaceId: 'tenant-a' });

  // The same graph shape must produce the same work regardless of which
  // workspace holds it. This is the assertion the issue's measurement failed.
  assert.ok(inTenant.dreams > 0, 'a non-default workspace must produce hypotheses');
  assert.equal(inTenant.dreams, inDefault.dreams);
  assert.equal(inTenant.deferred, inDefault.deferred);
  assert.equal(inTenant.added, inDefault.added);
});

test('#1189 the result names the workspace it is about', () => {
  const kernel = buildShape(makeKernel(), 'tenant-a');

  assert.equal(kernel.selfEvolve({ workspaceId: 'tenant-a' }).workspaceId, 'tenant-a');
  // A zero-counter answer is only readable if it says which workspace it read.
  const empty = kernel.selfEvolve({ workspaceId: 'tenant-b' });
  assert.equal(empty.workspaceId, 'tenant-b');
  assert.equal(empty.dreams, 0);
});

test('#1189 an omitted workspace still means default, so existing callers are unchanged', () => {
  const withoutOpts = buildShape(makeKernel(), 'default').selfEvolve();
  const withDefault = buildShape(makeKernel(), 'default').selfEvolve({ workspaceId: 'default' });

  assert.equal(withoutOpts.workspaceId, 'default');
  assert.equal(withoutOpts.dreams, withDefault.dreams);
  assert.equal(withoutOpts.deferred, withDefault.deferred);
});

test('#1189 dream() reads one workspace, not every node with default-workspace edges', () => {
  const kernel = makeKernel();
  buildShape(kernel, 'default');
  buildShape(kernel, 'tenant-a', [['ayri', 'kavram'], ['ikinci', 'kavram'], ['kavram', 'ust']]);

  const hypotheses = new Dream(kernel).dream({ workspaceId: 'tenant-a' });
  assert.ok(hypotheses.length > 0, 'the tenant workspace has its own shape to dream about');

  // No hypothesis may name a node that lives only in another workspace.
  const foreign = new Set(['kedi', 'kopek', 'kus', 'balik', 'hayvan', 'canli']);
  for (const hypothesis of hypotheses) {
    for (const id of [hypothesis.from, hypothesis.to, hypothesis.node].filter(Boolean)) {
      assert.ok(!foreign.has(id), `${id} belongs to another workspace`);
    }
  }
});

test('#1189 the duplicate check is scoped, so a foreign edge does not suppress a hypothesis', () => {
  const isolated = buildShape(makeKernel(), 'tenant-a').selfEvolve({ workspaceId: 'tenant-a' });

  // Same shape, plus every hypothesis-shaped edge already present in `default`.
  // With an unscoped getEdge() those would count as duplicates here.
  const shared = buildShape(makeKernel(), 'tenant-a');
  for (const hypothesis of isolated.deferredDetails) {
    shared.graph.addNode(hypothesis.from, hypothesis.from, null, { workspaceId: 'default' });
    shared.graph.addNode(hypothesis.to, hypothesis.to, null, { workspaceId: 'default' });
    shared.graph.addEdge(hypothesis.from, hypothesis.to, hypothesis.relation, {
      workspaceId: 'default', strength: 0.5, confidence: 0.5, source: 'manual',
    });
  }

  const after = shared.selfEvolve({ workspaceId: 'tenant-a' });
  assert.equal(after.deferred, isolated.deferred, 'edges in another workspace are not duplicates here');
});
