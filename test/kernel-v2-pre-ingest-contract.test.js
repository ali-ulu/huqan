'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');

test('KernelV2 learnAsync preserves the preIngest rewrite before entering V2 learn', async () => {
  const kernel = new KernelV2({ noLoad: true, loadPlugins: false });
  kernel.plugins.register({
    name: 'v2-pre-ingest-rewriter',
    requires: [],
    optional: [],
    preIngest: async (_kernel, payload) => ({
      ...payload,
      text: 'Köpek hayvandır',
    }),
  });

  await kernel.learnAsync(
    'Kedi hayvandır',
    Kernel.createAdmissionBypassOpts('characterization'),
  );

  assert.ok(kernel.graph.getNode('köpek'));
  assert.equal(kernel.graph.getNode('kedi'), null);
});

test('KernelV2 learnAsync keeps invalid preIngest payloads fail-closed', async () => {
  const kernel = new KernelV2({ noLoad: true, loadPlugins: false });
  kernel.plugins.register({
    name: 'v2-pre-ingest-invalid-shape',
    requires: [],
    optional: [],
    preIngest: async () => 'not a payload',
  });

  await assert.rejects(
    () => kernel.learnAsync(
      'Kedi hayvandır',
      Kernel.createAdmissionBypassOpts('characterization'),
    ),
    error => error && error.code === 'PRE_INGEST_INVALID_PAYLOAD',
  );
});

test('KernelV2 learnAsync does not reach through Kernel private pre-ingest state', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'kernel.v2.js'), 'utf8');
  const start = source.indexOf('  async learnAsync(');
  const end = source.indexOf('\n  async verifyAsync(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const body = source.slice(start, end);
  assert.doesNotMatch(body, /this\.kernel\._runPreIngest/);
});
