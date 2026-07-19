'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const CLI_SOURCE_PATH = path.join(__dirname, '..', 'cli.js');

const FORBIDDEN_PRODUCTION_CLI_GRAPH_ACCESSES = Object.freeze([
  '.graph.memoryPath',
  '.graph.load(',
  '.graph.save(',
  '.graph.optimize(',
  '.graph._nodes',
  '.graph._edges',
  '.graph.appendAuditEvent(',
]);

test('production CLI source does not use inventoried direct Graph access', () => {
  const source = fs.readFileSync(CLI_SOURCE_PATH, 'utf8');

  for (const access of FORBIDDEN_PRODUCTION_CLI_GRAPH_ACCESSES) {
    assert.equal(source.includes(access), false, `cli.js must not contain ${access}`);
  }
});
