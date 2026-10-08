'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { queueCliLearnReview } = require('../lib/cli-learn-review');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// #3644: `upload:`/`yükle:` names a file, so the durable review proposal must
// carry the file's content -- never the path text, which the old replay sent to
// huqan.learn and silently learned nothing.
test('CLI upload review reads the file and proposes its content, not the path', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-upload-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'zebra.txt');
  fs.writeFileSync(file, 'ZebraUniqueFact lives in the savanna.\n');

  let observed;
  queueCliLearnReview({
    kernel: { id: 'kernel' },
    approvalRuntime: () => ({ approvalStore: { id: 'store' } }),
    callTool: (...args) => { observed = args; return { approval: { id: 'approval-up' } }; },
  }, file, { readFile: true });

  assert.equal(observed[1].name, 'huqan.learn');
  assert.equal(observed[1].arguments.text, 'ZebraUniqueFact lives in the savanna.\n');
  assert.equal(observed[1].arguments.provenance.sourceSubType, 'cli.yukle');
  assert.equal(observed[1].arguments.provenance.sourceRef, `cli:yükle:${file}`);
});

test('CLI upload review of a missing file throws instead of queueing the path', () => {
  const missing = path.join(os.tmpdir(), 'huqan-upload-missing-xyz.txt');
  assert.throws(() => queueCliLearnReview({
    kernel: {}, approvalRuntime: () => ({}), callTool: () => ({ approval: { id: 'x' } }),
  }, missing, { readFile: true }), /ENOENT/);
});

test('CLI learn review uses the durable MCP proposal path with bounded provenance', () => {
  const kernel = { id: 'kernel' };
  const runtime = { approvalStore: { id: 'store' } };
  let observed;
  const result = queueCliLearnReview({
    kernel,
    approvalRuntime: () => runtime,
    callTool: (...args) => {
      observed = args;
      return { approval: { id: 'approval-cli', persisted: true } };
    },
  }, '  alpha beta  ');

  assert.equal(result.approval.id, 'approval-cli');
  assert.equal(observed[0], kernel);
  assert.equal(observed[1].name, 'huqan.learn');
  assert.deepEqual(observed[1].arguments, {
    text: 'alpha beta',
    workspaceId: 'default',
    provenance: {
      sourceType: 'user',
      sourceSubType: 'cli.learn',
      sourceRef: 'cli:learn',
      sourceTitle: 'CLI learn review candidate',
      actor: 'cli-user',
      workspaceId: 'default',
    },
  });
  assert.equal(observed[2], runtime);
});
