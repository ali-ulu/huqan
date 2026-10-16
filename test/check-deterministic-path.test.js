'use strict';

/**
 * check:deterministic-path tests (#2395, design #2384, acceptance test 8).
 *
 * Two things are verified: the real repository's declared execution
 * entrypoint (workflow-agent.js, per #2384's suggestion) does not
 * transitively reach llmAdapter.js today, AND the check actually detects a
 * reachable model-calling module when one is present — proven against a
 * throwaway fixture tree, not asserted from the real repo's current
 * (passing) state alone. A check that never fires on anything is not
 * evidence it works.
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { checkDeterministicPath } = require('../scripts/check-deterministic-path');

describe('check:deterministic-path', () => {
  it('the real repo: workflow-agent.js does not transitively reach llmAdapter.js', () => {
    const result = checkDeterministicPath();
    assert.equal(result.ok, true, JSON.stringify(result.violations));
  });

  it('fixture: fails the build when a fixture procedure transitively requires llmAdapter.js', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-det-path-'));
    try {
      fs.writeFileSync(path.join(dir, 'llmAdapter.js'), 'module.exports = {};\n');
      fs.writeFileSync(
        path.join(dir, 'chain-b.js'),
        "require('./llmAdapter.js');\nmodule.exports = {};\n",
      );
      fs.writeFileSync(
        path.join(dir, 'chain-a.js'),
        "require('./chain-b.js');\nmodule.exports = {};\n",
      );
      fs.writeFileSync(
        path.join(dir, 'entry.js'),
        "require('./chain-a.js');\nmodule.exports = {};\n",
      );
      const result = checkDeterministicPath({
        root: dir,
        entryPoints: ['entry.js'],
        modelCallingModules: ['llmAdapter.js'],
      });
      assert.equal(result.ok, false);
      assert.equal(result.violations.length, 1);
      assert.equal(result.violations[0].modelModule, 'llmAdapter.js');
      assert.deepEqual(result.violations[0].chain, ['entry.js', 'chain-a.js', 'chain-b.js', 'llmAdapter.js']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fixture: a clean chain with no model-calling module passes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-det-path-clean-'));
    try {
      fs.writeFileSync(path.join(dir, 'entry.js'), "require('./helper.js');\nmodule.exports = {};\n");
      fs.writeFileSync(path.join(dir, 'helper.js'), 'module.exports = {};\n');
      const result = checkDeterministicPath({
        root: dir,
        entryPoints: ['entry.js'],
        modelCallingModules: ['llmAdapter.js'],
      });
      assert.equal(result.ok, true);
      assert.deepEqual(result.violations, []);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
