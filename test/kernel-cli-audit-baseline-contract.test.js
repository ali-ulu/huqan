const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const CLI = require('../cli');

function closeManagedCli(cli) {
  const storage = cli?.agent?.storage;
  if (storage && typeof storage.close === 'function' && storage.db?.open !== false) {
    storage.close();
  }
  if (cli?.kernel?.graph && typeof cli.kernel.graph.close === 'function') {
    cli.kernel.graph.close();
  }
  if (cli?.kernel?.memory && typeof cli.kernel.memory.close === 'function') {
    cli.kernel.memory.close();
  }
}

function createIsolatedCli() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cli-audit-'));
  let cli;
  try {
    cli = new CLI({
      kernel: {
        noLoad: true,
        loadPlugins: false,
        useSQLite: false,
        memoryStoreUseSQLite: false,
        memoryPath: path.join(root, 'memory.json'),
        dbPath: path.join(root, 'memory.db'),
        memoryStorePath: path.join(root, 'memory-store.json'),
        memoryStoreDbPath: path.join(root, 'memory-store.db'),
      },
    });
  } catch (error) {
    fs.rmSync(root, { recursive: true, force: true });
    throw error;
  }

  return {
    cli,
    root,
    close() {
      closeManagedCli(cli);
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function captureRawAuditInput(cli) {
  const original = cli.kernel.graph.appendAuditEvent;
  const calls = [];
  cli.kernel.graph.appendAuditEvent = (event, opts) => {
    calls.push({ event, opts });
    return event;
  };
  return {
    calls,
    restore() {
      cli.kernel.graph.appendAuditEvent = original;
    },
  };
}

function createInteractiveHarness(cli) {
  const events = [];
  const originalCreateInterface = readline.createInterface;
  const originalLog = console.log;
  const originalExit = process.exit;
  const originalPersist = cli.kernel.persist;
  let lineHandler;
  let closeHandler;
  let restored = false;

  function restore() {
    if (restored) return;
    restored = true;
    readline.createInterface = originalCreateInterface;
    console.log = originalLog;
    process.exit = originalExit;
    cli.kernel.persist = originalPersist;
  }

  const rl = {
    on(event, handler) {
      if (event === 'line') lineHandler = handler;
      if (event === 'close') closeHandler = handler;
      return this;
    },
    prompt() {
      events.push('prompt');
    },
    close() {
      events.push('close');
      closeHandler?.();
    },
  };

  try {
    readline.createInterface = () => rl;
    console.log = message => events.push(`log:${message}`);
    process.exit = code => events.push(`exit:${code}`);
    cli.kernel.persist = () => events.push('persist');
    cli.start();
    if (typeof lineHandler !== 'function' || typeof closeHandler !== 'function') {
      throw new Error('interactive CLI handlers were not registered');
    }
    events.length = 0;
    return {
      events,
      line: input => Promise.resolve(lineHandler(input)),
      restore,
    };
  } catch (error) {
    restore();
    throw error;
  }
}

describe('REFACTOR-1C3C: current-source CLI audit baseline contracts', { concurrency: false }, () => {
  it('maps every currently audited mutation classification to one raw CLI event', () => {
    const managed = createIsolatedCli();
    const capture = captureRawAuditInput(managed.cli);
    const cases = [
      ['kaydet', '', 'UPDATE', 'allow', 'persistence', 'cli_persist_local', true, 'kaydet'],
      ['backup', '', 'EXPORTED', 'allow', 'export', 'cli_backup_export_local', true, 'backup'],
      ['restore', '', 'IMPORTED', 'allow', 'state_replace', 'cli_restore_state_replace_local', true, 'restore'],
      ['optimize', '', 'REVIEW', 'review', 'canonical', 'cli_canonical_mutation_requires_review', false, 'optimize'],
      ['evolve', '', 'REVIEW', 'review', 'canonical', 'cli_canonical_mutation_requires_review', false, 'evolve'],
      ['konsolide', '', 'REVIEW', 'review', 'canonical', 'cli_canonical_mutation_requires_review', false, 'konsolide'],
      ['düşün', 'başla', 'REVIEW', 'review', 'automation', 'cli_automation_requires_review', false, 'dusun'],
    ];

    try {
      for (const [command, args, eventType, decision, mutationType, reason, executed, targetId] of cases) {
        capture.calls.length = 0;
        const gate = managed.cli._evaluateCliMutationGate(command, args);
        assert.strictEqual(gate.decision, decision);
        assert.strictEqual(gate.canExecute, executed);
        assert.strictEqual(gate.reason, reason);
        assert.strictEqual(capture.calls.length, 1);
        assert.deepStrictEqual(capture.calls[0].opts, {});
        assert.deepStrictEqual(capture.calls[0].event, {
          eventType,
          targetType: 'cli_mutation',
          targetId,
          actor: 'cli-user',
          details: {
            source: 'cli',
            command: targetId,
            mutationType,
            decision,
            executed,
            reason,
          },
        });
      }
    } finally {
      capture.restore();
      managed.close();
    }
  });

  it('keeps the raw caller boundary bounded and lets Graph add normalized fields', () => {
    const managed = createIsolatedCli();
    const graph = managed.cli.kernel.graph;
    const originalAppend = graph.appendAuditEvent.bind(graph);
    const capture = captureRawAuditInput(managed.cli);

    try {
      managed.cli._evaluateCliMutationGate('backup', '');
      assert.strictEqual(capture.calls.length, 1);
      const { event, opts } = capture.calls[0];

      assert.deepStrictEqual(Object.keys(event).sort(), [
        'actor',
        'details',
        'eventType',
        'targetId',
        'targetType',
      ]);
      assert.deepStrictEqual(Object.keys(event.details).sort(), [
        'command',
        'decision',
        'executed',
        'mutationType',
        'reason',
        'source',
      ]);
      assert.deepStrictEqual(opts, {});
      for (const field of [
        'auditId',
        'timestamp',
        'workspaceId',
        'sourceRef',
        'provenanceId',
        'trustPolicyVersion',
        'provenance',
        'receipt',
        'approval',
      ]) {
        assert.strictEqual(Object.hasOwn(event, field), false, field);
      }

      capture.restore();
      const normalized = originalAppend(event, opts);
      assert.match(normalized.auditId, /\S/);
      assert.match(normalized.timestamp, /\S/);
      assert.strictEqual(normalized.workspaceId, 'default');
      assert.strictEqual(normalized.sourceRef, '');
      assert.strictEqual(normalized.provenanceId, '');
      assert.strictEqual(normalized.trustPolicyVersion, '');
      assert.strictEqual(graph.getAuditEvents({ targetId: 'backup' }).length, 1);
    } finally {
      capture.restore();
      managed.close();
    }
  });

  it('does not let classification metadata override the fixed CLI audit target', () => {
    const managed = createIsolatedCli();
    const capture = captureRawAuditInput(managed.cli);
    try {
      managed.cli._auditCliMutation('kaydet', {
        auditEvent: 'UPDATE',
        mutationType: 'persistence',
        reason: 'cli_persist_local',
        targetType: 'arbitrary_target',
        auditId: 'caller-controlled',
        timestamp: 'caller-controlled',
        details: { injected: true },
      }, 'allow', true);

      assert.strictEqual(capture.calls.length, 1);
      const raw = capture.calls[0].event;
      assert.strictEqual(raw.targetType, 'cli_mutation');
      assert.strictEqual(raw.targetId, 'kaydet');
      assert.strictEqual(Object.hasOwn(raw, 'auditId'), false);
      assert.strictEqual(Object.hasOwn(raw, 'timestamp'), false);
      assert.strictEqual(Object.hasOwn(raw.details, 'injected'), false);
    } finally {
      capture.restore();
      managed.close();
    }
  });

  it('isolates a missing audit surface from the gate and command result', () => {
    const managed = createIsolatedCli();
    const graph = managed.cli.kernel.graph;
    const original = graph.appendAuditEvent;
    try {
      graph.appendAuditEvent = undefined;
      const gate = managed.cli._evaluateCliMutationGate('kaydet', '');
      assert.strictEqual(gate.decision, 'allow');
      assert.strictEqual(gate.canExecute, true);
      assert.strictEqual(managed.cli.execute('kaydet', ''), 'Bilinmeyen komut.');
    } finally {
      graph.appendAuditEvent = original;
      managed.close();
    }
  });

  it('isolates a thrown append error from the gate and command result', () => {
    const managed = createIsolatedCli();
    const graph = managed.cli.kernel.graph;
    const original = graph.appendAuditEvent;
    const sentinel = new Error('audit append sentinel');
    let attempts = 0;
    try {
      graph.appendAuditEvent = () => {
        attempts += 1;
        throw sentinel;
      };
      const gate = managed.cli._evaluateCliMutationGate('kaydet', '');
      assert.strictEqual(gate.decision, 'allow');
      assert.strictEqual(gate.canExecute, true);
      assert.strictEqual(managed.cli.execute('kaydet', ''), 'Bilinmeyen komut.');
      assert.strictEqual(attempts, 2);
    } finally {
      graph.appendAuditEvent = original;
      managed.close();
    }
  });

  it('locks the direct execute kaydet eligibility-versus-outcome inconsistency', () => {
    const managed = createIsolatedCli();
    const capture = captureRawAuditInput(managed.cli);
    const originalPersist = managed.cli.kernel.persist;
    let persistCalls = 0;
    managed.cli.kernel.persist = () => {
      persistCalls += 1;
    };
    try {
      const result = managed.cli.execute('kaydet', '');
      assert.strictEqual(result, 'Bilinmeyen komut.');
      assert.strictEqual(persistCalls, 0);
      assert.strictEqual(capture.calls.length, 1);
      assert.strictEqual(capture.calls[0].event.details.executed, true);
      assert.strictEqual(capture.calls[0].event.details.decision, 'allow');
    } finally {
      managed.cli.kernel.persist = originalPersist;
      capture.restore();
      managed.close();
    }
  });

  it('records review audit before gate formatting and never invokes mutation', () => {
    const managed = createIsolatedCli();
    const graph = managed.cli.kernel.graph;
    const originalAppend = graph.appendAuditEvent;
    const originalFormat = managed.cli._formatCliGateMessage;
    const originalOptimize = managed.cli.kernel.optimize;
    const stages = [];
    try {
      graph.appendAuditEvent = event => {
        stages.push('audit');
        return event;
      };
      managed.cli._formatCliGateMessage = (...args) => {
        stages.push('format');
        return originalFormat.apply(managed.cli, args);
      };
      managed.cli.kernel.optimize = () => {
        stages.push('mutation');
        return { pruned: 0, removedNodes: 0 };
      };

      const result = managed.cli.execute('optimize', '');
      assert.match(result, /review gerektiriyor/);
      assert.deepStrictEqual(stages, ['audit', 'format']);
    } finally {
      graph.appendAuditEvent = originalAppend;
      managed.cli._formatCliGateMessage = originalFormat;
      managed.cli.kernel.optimize = originalOptimize;
      managed.close();
    }
  });

  it('keeps interactive kaydet on the current persist-output-prompt audit bypass', async () => {
    const managed = createIsolatedCli();
    const capture = captureRawAuditInput(managed.cli);
    const harness = createInteractiveHarness(managed.cli);
    try {
      await harness.line('kaydet');
      assert.deepStrictEqual(harness.events, [
        'persist',
        'log:Hafiza kaydedildi.',
        'prompt',
      ]);
      assert.strictEqual(capture.calls.length, 0);
    } finally {
      harness.restore();
      capture.restore();
      managed.close();
    }
  });

  for (const input of ['exit', 'cikis']) {
    it(`keeps interactive ${input} on the current persist-output-close audit bypass`, async () => {
      const managed = createIsolatedCli();
      const capture = captureRawAuditInput(managed.cli);
      const harness = createInteractiveHarness(managed.cli);
      try {
        await harness.line(input);
        assert.deepStrictEqual(harness.events, [
          'persist',
          'log:Hafiza kaydedildi. Gule gule.',
          'close',
          'exit:0',
        ]);
        assert.strictEqual(capture.calls.length, 0);
      } finally {
        harness.restore();
        capture.restore();
        managed.close();
      }
    });
  }

  it('keeps command output identical for normal, missing, and throwing audit surfaces', () => {
    const outputs = [];
    for (const mode of ['normal', 'missing', 'throwing']) {
      const managed = createIsolatedCli();
      const graph = managed.cli.kernel.graph;
      const original = graph.appendAuditEvent;
      try {
        if (mode === 'missing') graph.appendAuditEvent = undefined;
        if (mode === 'throwing') graph.appendAuditEvent = () => { throw new Error('audit failed'); };
        outputs.push(managed.cli.execute('kaydet', ''));
      } finally {
        graph.appendAuditEvent = original;
        managed.close();
      }
    }
    assert.deepStrictEqual(outputs, [
      'Bilinmeyen komut.',
      'Bilinmeyen komut.',
      'Bilinmeyen komut.',
    ]);
  });
});
