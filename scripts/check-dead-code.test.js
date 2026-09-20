'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkDeadCode, checkMcpToolSurface } = require('./check-dead-code');

const REPO_ROOT = path.join(__dirname, '..');

test('repo root passes dead-code check (reachability + MCP surface)', () => {
  const result = checkDeadCode({ root: REPO_ROOT });
  assert.equal(result.ok, true, result.report);
  assert.equal(result.unacknowledged.length, 0);
  assert.equal(result.staleAcknowledgements.length, 0);
  assert.equal(result.mcpGaps.length, 0);
  assert.ok(result.reachableCount > 50, 'walk must see real product modules');
});

test('MCP tool surface is consistent on the real tree', () => {
  const result = checkMcpToolSurface({ root: REPO_ROOT });
  assert.equal(result.ok, true, result.report);
  assert.equal(result.gaps.length, 0);
});

test('an unclassified orphan fails the gate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dead-code-'));
  try {
    fs.writeFileSync(path.join(root, 'cli.js'), "require('./used');\n");
    fs.writeFileSync(path.join(root, 'used.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(root, 'orphan.js'), 'module.exports = {};\n');
    // Minimal MCP surface files so slice 2 does not false-fail on temp roots
    fs.mkdirSync(path.join(root, 'lib', 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(root, 'lib', 'mcp-tool-names.js'), "const MCP_TOOL_SUFFIXES = Object.freeze(['learn']);\n");
    fs.writeFileSync(path.join(root, 'lib', 'mcp', 'tool-handlers.js'), "'huqan.learn': () => {},\n");
    fs.writeFileSync(path.join(root, 'lib', 'mcp', 'tool-dispatch.js'), "if (name === 'huqan.learn') {}\n");
    fs.writeFileSync(path.join(root, 'lib', 'mcp-tool-catalog.js'), "name: 'huqan.learn',\n");
    fs.writeFileSync(path.join(root, 'lib', 'mcp', 'operator-tool-schemas.js'), '// none\n');
    fs.writeFileSync(path.join(root, 'lib', 'workflow-contract.js'),
      'const CLI_COMMAND_CAPABILITIES = Object.freeze([].map(Boolean));\n');
    fs.writeFileSync(path.join(root, 'lib', 'cli-workflow-adapter.js'), '// no CLI adapter commands\n');

    const result = checkDeadCode({ root });
    assert.equal(result.ok, false);
    assert.ok(result.unacknowledged.includes('orphan.js'));
    assert.match(result.report, /orphan\.js/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MCP surface gap fails the gate', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-surface-'));
  try {
    fs.mkdirSync(path.join(root, 'lib', 'mcp'), { recursive: true });
    fs.writeFileSync(path.join(root, 'cli.js'), 'module.exports = {};\n');
    fs.writeFileSync(path.join(root, 'lib', 'mcp-tool-names.js'), "const MCP_TOOL_SUFFIXES = Object.freeze(['learn', 'ghost']);\n");
    fs.writeFileSync(path.join(root, 'lib', 'mcp', 'tool-handlers.js'), "'huqan.learn': () => {},\n");
    fs.writeFileSync(path.join(root, 'lib', 'mcp', 'tool-dispatch.js'), '// no special\n');
    fs.writeFileSync(path.join(root, 'lib', 'mcp-tool-catalog.js'), "name: 'huqan.learn',\n");
    fs.writeFileSync(path.join(root, 'lib', 'mcp', 'operator-tool-schemas.js'), '// none\n');

    const result = checkMcpToolSurface({ root });
    assert.equal(result.ok, false);
    assert.ok(result.gaps.some((g) => g.includes('ghost')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
