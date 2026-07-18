const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const CLI = require('../cli');
const KernelV2 = require('../kernel.v2');

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

function createIsolatedCli(kernelOverrides = {}) {
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
        ...kernelOverrides,
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

function expectedIntent({
  sourceCommand,
  mutationType,
  eventType,
  decision,
  executionEligible,
  reason,
}) {
  return {
    sourceCommand,
    mutationType,
    eventType,
    decision,
    executionEligible,
    reason,
    actor: 'cli-user',
  };
}

function captureKernelAudit(cli) {
  const original = cli.kernel.recordCliMutationAudit;
  const calls = [];
  cli.kernel.recordCliMutationAudit = intent => {
    calls.push(intent);
    return { auditRecorded: true, event: null, errorCode: null };
  };
  return {
    calls,
    original: original.bind(cli.kernel),
    restore() {
      cli.kernel.recordCliMutationAudit = original;
    },
  };
}

function createInteractiveHarness(cli, auditMode = 'record') {
  const events = [];
  const originalCreateInterface = readline.createInterface;
  const originalLog = console.log;
  const originalExit = process.exit;
  const originalPersist = cli.kernel.persist;
  const originalAudit = cli.kernel.recordCliMutationAudit;
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
    cli.kernel.recordCliMutationAudit = originalAudit;
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
    if (auditMode === 'missing') {
      cli.kernel.recordCliMutationAudit = undefined;
    } else {
      cli.kernel.recordCliMutationAudit = intent => {
        events.push(`audit:${intent.sourceCommand}`);
        if (auditMode === 'throwing') throw new Error('audit sentinel');
        return { auditRecorded: true, event: null, errorCode: null };
      };
    }
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

describe('REFACTOR-1C3E: CLI audit callsite migration contracts', { concurrency: false }, () => {
  it('removes direct Graph audit access from CLI source', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'cli.js'), 'utf8');
    assert.strictEqual(source.includes('.graph.appendAuditEvent'), false);
  });

  it('routes every mutation gate mapping through the Kernel seam exactly once', () => {
    const managed = createIsolatedCli();
    const capture = captureKernelAudit(managed.cli);
    const cases = [
      ['kaydet', '', 'UPDATE', 'allow', 'persistence', 'cli_persist_local', true, 'kaydet'],
      ['backup', '', 'EXPORTED', 'allow', 'export', 'cli_backup_export_local', true, 'backup'],
      ['restore', '', 'IMPORTED', 'allow', 'state_replace', 'cli_restore_state_replace_local', true, 'restore'],
      ['optimize', '', 'REVIEW', 'review', 'canonical', 'cli_canonical_mutation_requires_review', false, 'optimize'],
      ['evolve', '', 'REVIEW', 'review', 'canonical', 'cli_canonical_mutation_requires_review', false, 'evolve'],
      ['konsolide', '', 'REVIEW', 'review', 'canonical', 'cli_canonical_mutation_requires_review', false, 'konsolide'],
      ['d\u00fc\u015f\u00fcn', 'ba\u015fla', 'REVIEW', 'review', 'automation', 'cli_automation_requires_review', false, 'dusun'],
    ];

    try {
      for (const [command, args, eventType, decision, mutationType, reason, eligible, sourceCommand] of cases) {
        capture.calls.length = 0;
        const gate = managed.cli._evaluateCliMutationGate(command, args);
        assert.strictEqual(gate.decision, decision);
        assert.strictEqual(gate.canExecute, eligible);
        assert.strictEqual(gate.reason, reason);
        assert.strictEqual(capture.calls.length, 1);
        assert.deepStrictEqual(capture.calls[0], expectedIntent({
          sourceCommand,
          mutationType,
          eventType,
          decision,
          executionEligible: eligible,
          reason,
        }));
      }
    } finally {
      capture.restore();
      managed.close();
    }
  });

  it('keeps the Kernel intent bounded and lets Graph normalize the event', () => {
    const managed = createIsolatedCli();
    const capture = captureKernelAudit(managed.cli);
    try {
      managed.cli._evaluateCliMutationGate('backup', '');
      assert.strictEqual(capture.calls.length, 1);
      const intent = capture.calls[0];
      assert.deepStrictEqual(Object.keys(intent).sort(), [
        'actor',
        'decision',
        'eventType',
        'executionEligible',
        'mutationType',
        'reason',
        'sourceCommand',
      ]);
      capture.restore();
      const result = capture.original(intent);
      assert.strictEqual(result.auditRecorded, true);
      assert.match(result.event.auditId, /\S/);
      assert.match(result.event.timestamp, /\S/);
      assert.strictEqual(result.event.targetType, 'cli_mutation');
      assert.strictEqual(result.event.targetId, 'backup');
      assert.deepStrictEqual(result.event.details, {
        source: 'cli',
        command: 'backup',
        mutationType: 'export',
        decision: 'allow',
        executed: true,
        reason: 'cli_backup_export_local',
      });
    } finally {
      capture.restore();
      managed.close();
    }
  });

  it('does not forward classification metadata outside the bounded intent', () => {
    const managed = createIsolatedCli();
    const capture = captureKernelAudit(managed.cli);
    try {
      managed.cli._auditCliMutation('kaydet', {
        auditEvent: 'UPDATE',
        mutationType: 'persistence',
        reason: 'cli_persist_local',
        targetType: 'arbitrary_target',
        auditId: 'caller-controlled',
        details: { injected: true },
      }, 'allow', true);
      assert.strictEqual(capture.calls.length, 1);
      assert.deepStrictEqual(capture.calls[0], expectedIntent({
        sourceCommand: 'kaydet',
        mutationType: 'persistence',
        eventType: 'UPDATE',
        decision: 'allow',
        executionEligible: true,
        reason: 'cli_persist_local',
      }));
    } finally {
      capture.restore();
      managed.close();
    }
  });

  for (const mode of ['missing', 'throwing']) {
    it(`isolates a ${mode} Kernel audit seam from direct command results`, () => {
      const managed = createIsolatedCli();
      const original = managed.cli.kernel.recordCliMutationAudit;
      let attempts = 0;
      try {
        managed.cli.kernel.recordCliMutationAudit = mode === 'missing'
          ? undefined
          : () => { attempts += 1; throw new Error('audit sentinel'); };
        const gate = managed.cli._evaluateCliMutationGate('kaydet', '');
        assert.strictEqual(gate.decision, 'allow');
        assert.strictEqual(gate.canExecute, true);
        assert.strictEqual(managed.cli.execute('kaydet', ''), 'Bilinmeyen komut.');
        assert.strictEqual(attempts, mode === 'throwing' ? 2 : 0);
      } finally {
        managed.cli.kernel.recordCliMutationAudit = original;
        managed.close();
      }
    });
  }

  it('preserves the direct execute kaydet compatibility result', () => {
    const managed = createIsolatedCli();
    const capture = captureKernelAudit(managed.cli);
    const originalPersist = managed.cli.kernel.persist;
    let persistCalls = 0;
    managed.cli.kernel.persist = () => { persistCalls += 1; };
    try {
      assert.strictEqual(managed.cli.execute('kaydet', ''), 'Bilinmeyen komut.');
      assert.strictEqual(persistCalls, 0);
      assert.strictEqual(capture.calls.length, 1);
      assert.deepStrictEqual(capture.calls[0], expectedIntent({
        sourceCommand: 'kaydet',
        mutationType: 'persistence',
        eventType: 'UPDATE',
        decision: 'allow',
        executionEligible: true,
        reason: 'cli_persist_local',
      }));
    } finally {
      managed.cli.kernel.persist = originalPersist;
      capture.restore();
      managed.close();
    }
  });

  it('records review audit before formatting and never invokes mutation', () => {
    const managed = createIsolatedCli();
    const originalAudit = managed.cli.kernel.recordCliMutationAudit;
    const originalFormat = managed.cli._formatCliGateMessage;
    const originalOptimize = managed.cli.kernel.optimize;
    const stages = [];
    try {
      managed.cli.kernel.recordCliMutationAudit = () => {
        stages.push('audit');
        return { auditRecorded: true, event: null, errorCode: null };
      };
      managed.cli._formatCliGateMessage = (...args) => {
        stages.push('format');
        return originalFormat.apply(managed.cli, args);
      };
      managed.cli.kernel.optimize = () => {
        stages.push('mutation');
        return { pruned: 0, removedNodes: 0 };
      };
      assert.match(managed.cli.execute('optimize', ''), /review gerektiriyor/);
      assert.deepStrictEqual(stages, ['audit', 'format']);
    } finally {
      managed.cli.kernel.recordCliMutationAudit = originalAudit;
      managed.cli._formatCliGateMessage = originalFormat;
      managed.cli.kernel.optimize = originalOptimize;
      managed.close();
    }
  });

  it('audits interactive kaydet before persist, output, and prompt', async () => {
    const managed = createIsolatedCli();
    const harness = createInteractiveHarness(managed.cli);
    try {
      await harness.line('kaydet');
      assert.deepStrictEqual(harness.events, [
        'audit:kaydet',
        'persist',
        'log:Hafiza kaydedildi.',
        'prompt',
      ]);
    } finally {
      harness.restore();
      managed.close();
    }
  });

  for (const [input, sourceCommand] of [
    ['exit', 'exit'],
    ['quit', 'exit'],
    ['cikis', 'cikis'],
    ['\u00e7\u0131k\u0131\u015f', 'cikis'],
  ]) {
    it(`audits interactive ${input} before persist, output, close, and exit`, async () => {
      const managed = createIsolatedCli();
      const harness = createInteractiveHarness(managed.cli);
      try {
        await harness.line(input);
        assert.deepStrictEqual(harness.events, [
          `audit:${sourceCommand}`,
          'persist',
          'log:Hafiza kaydedildi. Gule gule.',
          'close',
          'exit:0',
        ]);
      } finally {
        harness.restore();
        managed.close();
      }
    });
  }

  for (const mode of ['missing', 'throwing']) {
    it(`keeps interactive persistence behavior with a ${mode} audit seam`, async () => {
      const managed = createIsolatedCli();
      const harness = createInteractiveHarness(managed.cli, mode);
      try {
        await harness.line('kaydet');
        const nonAuditEvents = harness.events.filter(event => !event.startsWith('audit:'));
        assert.deepStrictEqual(nonAuditEvents, [
          'persist',
          'log:Hafiza kaydedildi.',
          'prompt',
        ]);
      } finally {
        harness.restore();
        managed.close();
      }
    });
  }

  it('keeps the dusun stop control path unaudited', () => {
    const managed = createIsolatedCli();
    const capture = captureKernelAudit(managed.cli);
    const originalStop = managed.cli.kernel.stopAutoThink;
    let stopCalls = 0;
    managed.cli.kernel.stopAutoThink = () => { stopCalls += 1; };
    try {
      const parsed = managed.cli.parse('d\u00fc\u015f\u00fcnmeyi durdur');
      assert.strictEqual(managed.cli.execute(parsed.command, parsed.args), 'Dusunmeyi durdurdum.');
      assert.strictEqual(stopCalls, 1);
      assert.strictEqual(capture.calls.length, 0);
    } finally {
      managed.cli.kernel.stopAutoThink = originalStop;
      capture.restore();
      managed.close();
    }
  });

  it('uses one KernelV2 seam call and one underlying Graph append', () => {
    const managed = createIsolatedCli({ version: 'v2' });
    assert.ok(managed.cli.kernel instanceof KernelV2);
    const v2 = managed.cli.kernel;
    const graph = v2.graph;
    const originalSeam = v2.recordCliMutationAudit;
    const originalAppend = graph.appendAuditEvent;
    let seamCalls = 0;
    let appendCalls = 0;
    try {
      v2.recordCliMutationAudit = intent => {
        seamCalls += 1;
        return originalSeam.call(v2, intent);
      };
      graph.appendAuditEvent = (...args) => {
        appendCalls += 1;
        return originalAppend.apply(graph, args);
      };
      const gate = managed.cli._evaluateCliMutationGate('backup', '');
      assert.strictEqual(gate.canExecute, true);
      assert.strictEqual(seamCalls, 1);
      assert.strictEqual(appendCalls, 1);
    } finally {
      v2.recordCliMutationAudit = originalSeam;
      graph.appendAuditEvent = originalAppend;
      managed.close();
    }
  });

  it('keeps backup and restore output and operation ordering behind the audit seam', () => {
    const managed = createIsolatedCli();
    const originalAudit = managed.cli.kernel.recordCliMutationAudit;
    const originalOptions = managed.cli._backupOptions;
    const originalReload = managed.cli.kernel.reload;
    const stages = [];
    try {
      managed.cli.agent.storage.close();
      managed.cli.kernel.persist();
      managed.cli.kernel.recordCliMutationAudit = intent => {
        stages.push(`audit:${intent.sourceCommand}`);
        return originalAudit.call(managed.cli.kernel, intent);
      };
      managed.cli._backupOptions = extra => {
        const kind = Object.prototype.hasOwnProperty.call(extra || {}, 'backupDir') ? 'restore' : 'backup';
        stages.push(`command:${kind}`);
        return originalOptions.call(managed.cli, extra);
      };
      managed.cli.kernel.reload = () => {
        stages.push('reload');
        return originalReload.call(managed.cli.kernel);
      };

      const backupResult = managed.cli.execute('backup', '');
      assert.match(backupResult, /^Backup tamamlandi:/);
      assert.deepStrictEqual(stages, ['audit:backup', 'command:backup']);

      stages.length = 0;
      const restoreResult = managed.cli.execute('restore', '');
      assert.match(restoreResult, /^Restore tamamlandi:/);
      assert.deepStrictEqual(stages, ['audit:restore', 'command:restore', 'reload']);
    } finally {
      managed.cli.kernel.recordCliMutationAudit = originalAudit;
      managed.cli._backupOptions = originalOptions;
      managed.cli.kernel.reload = originalReload;
      managed.close();
    }
  });
});
