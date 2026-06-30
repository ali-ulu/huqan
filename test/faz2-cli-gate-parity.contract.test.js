'use strict';
/**
 * FAZ2-PR6 — CLI Gate Parity Contract Tests (F-004)
 *
 * F-004 closed: every CLI command that can mutate persistence, the canonical
 * graph, or background automation now runs through a gate. _evaluateCliGate no
 * longer returns null for mutation-bearing commands — it returns either a
 * review decision (canonical/automation mutations, execute() short-circuits) or
 * an audited allow decision (local persistence/recovery ops that must still
 * run). This mirrors the REST surface, where requestGuards
 * UNSAFE_PUBLIC_API_COMMANDS blocks the same commands on the public API.
 *
 * Mechanism:
 *   cli.js mapCliCommandToMcpTool  — maps öğret/öğren/yükle/company-ingest to
 *                                    axiom.learn (gated via the MCP gate).
 *   cli.js CLI_MUTATION_GATE       — classifies kaydet/backup/restore/evolve/
 *                                    optimize/konsolide/düşün/rüya so
 *                                    _evaluateCliGate never short-circuits to
 *                                    null for a mutation command.
 *
 * Historical note: prior revisions of this file asserted the RED gap
 * (_evaluateCliGate returning null). Those assertions are intentionally
 * inverted here now that FAZ2-6 has closed F-004.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const CLI = require('../cli');
const Kernel = require('../kernel');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function makeCLI() {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
  const cli = new CLI({ kernelInstance: kernel });
  return cli;
}

/**
 * Mutation-bearing CLI commands that previously bypassed the gate (returned
 * null). After FAZ2-6 each must return a non-null gate decision.
 */
const MUTATION_COMMANDS = [
  'kaydet',
  'backup',
  'restore',
  'rüya',
  'evolve',
  'düşün',
  'optimize',
  'konsolide',
];

/**
 * Commands mapped to an MCP tool (mapCliCommandToMcpTool returns non-null).
 * These must stay gated.
 */
const GATED_COMMANDS = [
  { command: 'öğret',  expectedTool: 'axiom.learn' },
  { command: 'öğren',  expectedTool: 'axiom.learn' }, // FAZ2-6: learn alias now mapped
  { command: 'yükle',  expectedTool: 'axiom.learn' },
  { command: 'sor',    expectedTool: 'axiom.ask'   },
  { command: 'verify', expectedTool: 'axiom.verify' },
];

// ---------------------------------------------------------------------------
// SECTION 1: Harness sanity
// ---------------------------------------------------------------------------
describe('FAZ2-PR1 contract: F-004 CLI gate parity — harness', () => {
  it('CLI class loads without error', () => {
    assert.ok(typeof CLI === 'function', 'CLI must be a constructor');
  });

  it('CLI instantiates with a fresh kernel', () => {
    const cli = makeCLI();
    assert.ok(cli.kernel, 'cli.kernel must exist');
  });

  it('_evaluateCliGate method exists on CLI prototype', () => {
    const cli = makeCLI();
    assert.strictEqual(
      typeof cli._evaluateCliGate,
      'function',
      '_evaluateCliGate must be a function'
    );
  });

  it('both öğren (learn alias) and öğret (teach) are now gated (F-004 closed)', () => {
    // Previously 'öğren' (→ ogren) was unmapped and returned null. FAZ2-6 maps
    // it to axiom.learn so the learn alias is gated like öğret.
    const cli = makeCLI();
    const learnAlias   = cli._evaluateCliGate('öğren', '');
    const teachCommand = cli._evaluateCliGate('öğret', '');
    assert.notStrictEqual(learnAlias, null,
      "'öğren' (learn alias) must be gated — no longer returns null");
    assert.notStrictEqual(teachCommand, null,
      "'öğret' (teach command) must be gated — mapped to axiom.learn");
  });
});

// ---------------------------------------------------------------------------
// SECTION 2: Mutation commands are gated (F-004 closed)
// ---------------------------------------------------------------------------
describe('FAZ2-PR6 contract: F-004 mutation commands are gated', () => {
  for (const cmd of MUTATION_COMMANDS) {
    it(`_evaluateCliGate('${cmd}') returns a gate decision (never null)`, () => {
      const cli = makeCLI();
      const result = cli._evaluateCliGate(cmd, '');
      assert.notStrictEqual(
        result,
        null,
        `_evaluateCliGate('${cmd}') must not return null — the gate must run`
      );
      assert.ok(result && typeof result.decision === 'string',
        `_evaluateCliGate('${cmd}') must produce a decision`);
    });
  }
});

// ---------------------------------------------------------------------------
// SECTION 3: Currently gated commands — must stay gated
// ---------------------------------------------------------------------------
describe('FAZ2-PR1 contract: F-004 currently gated commands stay gated', () => {
  for (const { command, expectedTool } of GATED_COMMANDS) {
    it(`_evaluateCliGate('${command}') returns a gate result (tool: ${expectedTool})`, () => {
      const cli = makeCLI();
      const result = cli._evaluateCliGate(command, 'test value');
      assert.notStrictEqual(
        result,
        null,
        `_evaluateCliGate('${command}') must not return null — gate must run for ${expectedTool}`
      );
    });
  }
});

// ---------------------------------------------------------------------------
// SECTION 4: Mutation gate decisions are correct (no silent canonical write)
// ---------------------------------------------------------------------------
describe('FAZ2-PR6 contract: F-004 mutation gate decisions', () => {
  // Canonical-graph / automation mutations must be reviewed (execute() blocks).
  for (const cmd of ['evolve', 'optimize', 'konsolide', 'düşün']) {
    it(`'${cmd}' is reviewed and cannot execute silently`, () => {
      const cli = makeCLI();
      const result = cli._evaluateCliGate(cmd, '');
      assert.notStrictEqual(result, null, `gate must run for '${cmd}'`);
      assert.strictEqual(result.decision, 'review', `'${cmd}' must be reviewed`);
      assert.strictEqual(result.canExecute, false, `'${cmd}' must not execute under review`);
    });
  }

  // Local persistence/recovery ops are allowed but audited (must still run).
  for (const cmd of ['kaydet', 'backup', 'restore']) {
    it(`'${cmd}' is allowed (local) and audited`, () => {
      const cli = makeCLI();
      const before = (cli.kernel.graph._auditEvents || []).length;
      const result = cli._evaluateCliGate(cmd, '');
      assert.notStrictEqual(result, null, `gate must run for '${cmd}'`);
      assert.strictEqual(result.canExecute, true, `'${cmd}' must remain executable locally`);
      const after = (cli.kernel.graph._auditEvents || []).length;
      assert.ok(after > before, `'${cmd}' must emit an audit event (no silent mutation)`);
    });
  }

  it("'öğren' alias is mapped so _evaluateCliGate returns a gate result", () => {
    const cli = makeCLI();
    const result = cli._evaluateCliGate('öğren', '');
    assert.notStrictEqual(result, null, "'öğren' alias must be gated");
  });

  it('_evaluateCliGate returns a non-null decision for every mutation command', () => {
    const cli = makeCLI();
    for (const cmd of MUTATION_COMMANDS) {
      const result = cli._evaluateCliGate(cmd, '');
      assert.notStrictEqual(result, null,
        `mutation command '${cmd}' must be gated (no null short-circuit)`);
    }
  });
});
