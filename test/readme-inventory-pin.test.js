'use strict';

/**
 * The README states two inventories that actually live in code: how many
 * executables the package publishes, and which MCP tools are hidden from the
 * model behind the operator token.
 *
 * Both drifted silently. The "Three binaries" line predated
 * `huqan-cognitive-lab` (#3440) and `huqan-causal-lab` (#3467), and the
 * operator list named three of the five entries in
 * lib/mcp/tool-surface.js OPERATOR_TOOL_NAMES. No test read either claim, so
 * the page and the package disagreed until a reader checked by hand.
 *
 * These assertions bind the README to the two sources of truth rather than to
 * the words a past edit happened to use: the count and the names come from
 * package.json and tool-surface.js, so adding an executable or an operator tool
 * without updating the page fails here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pkg = require('../package.json');
const { OPERATOR_TOOL_NAMES } = require('../lib/mcp/tool-surface');

const README = fs.readFileSync(path.join(__dirname, '..', 'README.md'), 'utf8');

const COUNT_WORDS = Object.freeze({
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
});

const COUNT_WORD_PATTERN = /\b(one|two|three|four|five|six|seven|eight|nine|ten)\b/i;

/** Backticked `huqan.*` tool names inside a segment of the README. */
function backtickedTools(segment) {
  return [...segment.matchAll(/`(huqan\.[a-z_]+)`/g)].map((match) => match[1]);
}

test('the README names every published binary and states the right count', () => {
  const binaries = Object.keys(pkg.bin);
  const line = README.split('\n').find((candidate) => /binaries:/i.test(candidate));
  assert.ok(line, 'the README must state how many binaries the package publishes');

  const stated = line.match(COUNT_WORD_PATTERN)[1].toLowerCase();
  assert.equal(
    COUNT_WORDS[stated],
    binaries.length,
    `the README says "${stated}" binaries but package.json publishes ${binaries.length}`,
  );

  for (const name of binaries) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(line, new RegExp(`\`${escaped}\``), `the README omits the \`${name}\` binary`);
  }
});

test('the README lists exactly the model-hidden operator tools', () => {
  const line = README.split('\n').find((candidate) => /are hidden from the model/.test(candidate));
  assert.ok(line, 'the README must say which MCP tools are hidden from the model');

  assert.deepEqual(
    backtickedTools(line).sort(),
    [...OPERATOR_TOOL_NAMES].sort(),
    'the README operator-tool list must match lib/mcp/tool-surface.js OPERATOR_TOOL_NAMES',
  );
});
