'use strict';
/**
 * FAZ2-PR6 — REST/CLI Mutation Gate Parity (F-004)
 *
 * Proves that CLI and REST mutation surfaces agree: a command that the REST
 * public API blocks (requestGuards UNSAFE_PUBLIC_API_COMMANDS) is never
 * silently executed by the CLI — the CLI gate runs for it, producing either a
 * review decision (no canonical write) or an audited allow decision.
 *
 * Read-only commands stay usable on the CLI and are not fake-gated.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const CLI = require('../cli');
const Kernel = require('../kernel');
const { isUnsafePublicApiCommand, isAllowedPublicCommand } = require('../requestGuards');

function makeCLI(opts = {}) {
  const kernel = new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false, ...opts });
  return new CLI({ kernelInstance: kernel });
}

function auditEvents(cli) {
  return cli.kernel.graph._auditEvents || [];
}

function nodeCount(cli) {
  return Object.keys(cli.kernel.graph._nodes || {}).length;
}

function edgeCount(cli) {
  return (cli.kernel.graph._edges || []).length;
}

// Mutation commands the CLI exposes and the REST public API treats as unsafe.
const CLI_MUTATION_COMMANDS = ['kaydet', 'backup', 'restore', 'evolve', 'optimize', 'konsolide', 'düşün', 'öğret', 'öğren', 'yükle'];

describe('FAZ2-PR6: REST/CLI mutation gate parity (F-004)', () => {
  // 1. CLI learn-style mutation uses an admission-aware (gated) path.
  it('CLI learn mutation (öğret) is gated, not a silent write', () => {
    const cli = makeCLI();
    const gate = cli._evaluateCliGate('öğret', 'Kedi hayvandır');
    assert.notStrictEqual(gate, null, 'öğret must be gated');
    assert.strictEqual(gate.canExecute, false, 'öğret must require review, not execute silently');
  });

  // 2. CLI mutation resulting in review does not force a canonical write.
  it('reviewed CLI mutation (öğret) does not mutate the canonical graph', () => {
    const cli = makeCLI();
    const before = nodeCount(cli);
    const out = cli.execute('öğret', 'Kedi hayvandır');
    assert.ok(String(out).includes('review gerektiriyor'), 'execute must surface the review gate');
    assert.strictEqual(nodeCount(cli), before, 'no canonical node may be written under review');
    assert.ok(!cli.kernel.graph.getNode('kedi'), 'reviewed learn must not create a node');
  });

  it('reviewed CLI maintenance mutation (optimize) does not execute', () => {
    const cli = makeCLI();
    const gate = cli._evaluateCliGate('optimize', '');
    assert.strictEqual(gate.decision, 'review');
    assert.strictEqual(gate.canExecute, false, 'optimize must not run under review');
  });

  // 3. Allow-decision CLI mutation writes WITH an audit event (no silent op).
  it('allowed local CLI mutation (backup) emits an audit event', () => {
    const cli = makeCLI();
    const before = auditEvents(cli).length;
    const gate = cli._evaluateCliGate('backup', '');
    assert.strictEqual(gate.canExecute, true, 'backup must remain executable locally');
    const events = auditEvents(cli);
    assert.ok(events.length > before, 'backup must emit an audit event');
    assert.strictEqual(events[events.length - 1].eventType, 'EXPORTED');
    assert.strictEqual(events[events.length - 1].targetType, 'cli_mutation');
  });

  it('allowed local CLI mutation (restore) emits an audit event', () => {
    const cli = makeCLI();
    const before = auditEvents(cli).length;
    cli._evaluateCliGate('restore', '');
    const events = auditEvents(cli);
    assert.ok(events.length > before, 'restore must emit an audit event');
    assert.strictEqual(events[events.length - 1].eventType, 'IMPORTED');
  });

  // 4. REST equivalent route has matching gate behavior (blocks the mutation).
  it('REST public API marks the same learn/maintenance commands unsafe', () => {
    for (const cmd of ['ogret', 'ogren', 'learn', 'kaydet', 'backup', 'restore', 'optimize', 'konsolide', 'evolve', 'dusun']) {
      assert.strictEqual(isUnsafePublicApiCommand(cmd), true,
        `REST public API must treat '${cmd}' as unsafe`);
    }
  });

  // 5. Representative CLI/REST parity: REST-unsafe => CLI gate is non-null.
  it('every REST-unsafe CLI mutation command is gated on the CLI (no null bypass)', () => {
    const cli = makeCLI();
    for (const cmd of CLI_MUTATION_COMMANDS) {
      const restUnsafe = isUnsafePublicApiCommand(cmd);
      const cliGate = cli._evaluateCliGate(cmd, '');
      assert.strictEqual(restUnsafe, true, `REST must block mutation command '${cmd}'`);
      assert.notStrictEqual(cliGate, null,
        `CLI must gate mutation command '${cmd}' that REST blocks (parity)`);
    }
  });

  // 6. Read-only commands stay usable on the CLI and are not fake-gated.
  it('read-only CLI commands are not treated as mutations', () => {
    const cli = makeCLI();
    for (const cmd of ['durum', 'selam', 'yardım']) {
      assert.strictEqual(cli._evaluateCliGate(cmd, ''), null,
        `read-only command '${cmd}' must not be gated as a mutation`);
    }
    // 'rüya' is classified (non-null) but read-only: it must still execute and
    // must not mutate the canonical graph.
    cli.kernel.learn('Köpek memelidir', { admissionRequired: false, admissionBypassReason: 'test_fixture' });
    const edgesBefore = edgeCount(cli);
    const ruyaGate = cli._evaluateCliGate('rüya', '');
    assert.notStrictEqual(ruyaGate, null, 'rüya is classified');
    assert.strictEqual(ruyaGate.canExecute, true, 'rüya (read-only) must stay executable');
    const out = cli.execute('rüya', '');
    assert.ok(out, 'rüya must produce output');
    assert.strictEqual(edgeCount(cli), edgesBefore, 'rüya must not mutate the canonical graph');
  });

  // 7. Backup/restore/load-style commands are explicitly classified + audited.
  it('backup/restore/kaydet are explicitly classified and audited', () => {
    for (const cmd of ['backup', 'restore', 'kaydet']) {
      const cli = makeCLI();
      const before = auditEvents(cli).length;
      const gate = cli._evaluateCliGate(cmd, '');
      assert.notStrictEqual(gate, null, `'${cmd}' must be classified`);
      assert.ok(auditEvents(cli).length > before, `'${cmd}' must be audited`);
    }
  });

  // 8. No broad CLI bypass pattern exists.
  it('CLI gate never emits the forbidden bypass pattern', () => {
    const cli = makeCLI();
    for (const cmd of CLI_MUTATION_COMMANDS.concat(['rüya', 'sor', 'durum'])) {
      const gate = cli._evaluateCliGate(cmd, '');
      if (!gate) continue;
      assert.notStrictEqual(gate.reason, 'cli', 'reason must be specific, not a blanket "cli" bypass');
      assert.notStrictEqual(gate.admissionBypassReason, 'cli',
        'admissionBypassReason:"cli" is the forbidden bypass pattern');
      assert.notStrictEqual(gate.admissionRequired, false,
        'gate result must never arm admissionRequired:false');
    }
  });

  // REST public allowlist remains tightly scoped to read-only commands.
  it('REST public allowlist contains only read-only commands', () => {
    for (const cmd of ['selam', 'yardim', 'sor', 'durum', 'anlamadim']) {
      assert.strictEqual(isAllowedPublicCommand(cmd), true, `'${cmd}' should be public-allowed`);
    }
    for (const cmd of ['kaydet', 'backup', 'restore', 'optimize', 'evolve', 'ogret']) {
      assert.strictEqual(isAllowedPublicCommand(cmd), false,
        `mutation command '${cmd}' must not be in the public allowlist`);
    }
  });
});
