'use strict';

// #2346: the CLI→MCP alias table is data, not control flow. Adding a new
// alias for an MCP tool extends the table below; the lookup itself never
// changes, so the dispatch cannot rot into an untested switch again.
const assert = require('node:assert/strict');
const test = require('node:test');

const { mapCliCommandToMcpTool } = require('../lib/cli-helpers');

test('CLI command aliases resolve to their MCP tools (#2346)', () => {
  const cases = [
    ['öğret', 'huqan.learn'],
    ['ÖĞRET', 'huqan.learn'],
    ['öğren', 'huqan.learn'],
    ['yükle', 'huqan.learn'],
    ['company-ingest', 'huqan.learn'],
    ['company ingest', 'huqan.learn'],
    ['ajan', 'huqan.agent'],
    ['plan', 'huqan.agent'],
    ['onaylar', 'huqan.approvals'],
    ['sor', 'huqan.ask'],
    ['verify', 'huqan.verify'],
    ['neden', 'huqan.reason'],
    ['karşılaştır', 'huqan.compare'],
  ];
  for (const [command, tool] of cases) {
    assert.strictEqual(mapCliCommandToMcpTool(command), tool, `'${command}' must map to ${tool}`);
  }
});

test('unknown CLI commands map to null, never to a tool (#2346)', () => {
  for (const command of ['', 'kaydet', 'rya', 'learn', 'huqan.learn']) {
    assert.strictEqual(mapCliCommandToMcpTool(command), null, `'${command}' must not map to any tool`);
  }
});
