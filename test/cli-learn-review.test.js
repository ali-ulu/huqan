'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { queueCliLearnReview } = require('../lib/cli-learn-review');

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
