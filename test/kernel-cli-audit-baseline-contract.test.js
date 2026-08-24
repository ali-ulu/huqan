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
  phase = 'attempted',
}) {
  return {
    sourceCommand,
    mutationType,
    eventType,
    decision,
    executionEligible,
    reason,
    actor: 'cli-user',
    phase,
  };
}

function captureKernelAudit(cli) {
  const original = cli.kernel.recordCliMutationAudit;
  const calls = [];
  const capture = {
    calls,
    /** Optional hook so a test can observe audit calls in execution order. */
    onCall: null,
    original: original.bind(cli.kernel),
    restore() {
      cli.kernel.recordCliMutationAudit = original;
    },
  };
  cli.kernel.recordCliMutationAudit = intent => {
    calls.push(intent);
    if (typeof capture.onCall === 'function') capture.onCall(intent);
    return { auditRecorded: true, event: null, errorCode: null };
  };
  return capture;
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
        events.push(`audit:${intent.sourceCommand}:${intent.phase}`);
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
      /**
       * Runs one input line and then drains the readline close chain.
       *
       * `rl.close()` does not exit inline: it queues `lineQueue.then(... =>
       * process.exit(0))`, which resolves a tick after this line's promise. If
       * the harness restores the real `process.exit` before that tick, the
       * queued callback exits the test process for real -- silently taking
       * every later test in this file with it, and reporting the file as a
       * pass. Settling the queue here keeps the stub installed until the exit
       * has been recorded as an event.
       */
      line: async (input) => {
        await lineHandler(input);
        await new Promise(resolve => setImmediate(resolve));
      },
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
        'phase',
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
        phase: 'attempted',
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

  // #760: an audit sink that is absent or throwing is an unavailable sink, and
  // the gate's whole promise is that these commands never mutate unaudited. So
  // the command is refused rather than run without its evidence.
  for (const mode of ['missing', 'throwing']) {
    it(`fails a ${mode} Kernel audit seam closed instead of mutating unaudited`, () => {
      const managed = createIsolatedCli();
      const original = managed.cli.kernel.recordCliMutationAudit;
      const originalPersist = managed.cli.kernel.persist;
      let attempts = 0;
      let persistCalls = 0;
      try {
        managed.cli.kernel.persist = () => { persistCalls += 1; };
        managed.cli.kernel.recordCliMutationAudit = mode === 'missing'
          ? undefined
          : () => { attempts += 1; throw new Error('audit sentinel'); };

        const gate = managed.cli._evaluateCliMutationGate('kaydet', '');
        assert.strictEqual(gate.decision, 'block');
        assert.strictEqual(gate.canExecute, false);
        assert.strictEqual(gate.reason, 'cli_audit_write_failed');
        assert.strictEqual(gate.metadata.auditRecorded, false);
        assert.strictEqual(
          gate.metadata.auditErrorCode,
          mode === 'missing' ? 'AUDIT_SINK_UNAVAILABLE' : 'AUDIT_WRITE_FAILED',
        );

        assert.match(managed.cli.execute('kaydet', ''), /engellendi/);
        assert.strictEqual(persistCalls, 0, 'state was persisted without an audit record');
        assert.strictEqual(attempts, mode === 'throwing' ? 2 : 0);
      } finally {
        managed.cli.kernel.recordCliMutationAudit = original;
        managed.cli.kernel.persist = originalPersist;
        managed.close();
      }
    });
  }

  it('leaves read-only commands usable when the audit sink is unavailable', () => {
    const managed = createIsolatedCli();
    const original = managed.cli.kernel.recordCliMutationAudit;
    try {
      managed.cli.kernel.recordCliMutationAudit = undefined;
      // `durum` has nothing to audit, so a broken sink is none of its business.
      assert.strictEqual(managed.cli._evaluateCliMutationGate('durum', ''), null);
      assert.match(managed.cli.execute('durum', ''), /^Status: /);
    } finally {
      managed.cli.kernel.recordCliMutationAudit = original;
      managed.close();
    }
  });

  it('keeps review-gated commands non-executable when audit fails', () => {
    const managed = createIsolatedCli();
    const original = managed.cli.kernel.recordCliMutationAudit;
    const originalOptimize = managed.cli.kernel.optimize;
    let optimizeCalls = 0;
    try {
      managed.cli.kernel.optimize = () => { optimizeCalls += 1; return { pruned: 0, removedNodes: 0 }; };
      managed.cli.kernel.recordCliMutationAudit = () => { throw new Error('audit sentinel'); };

      const gate = managed.cli._evaluateCliMutationGate('optimize', '');
      assert.strictEqual(gate.canExecute, false);
      assert.strictEqual(gate.canDryRun, false, 'a dry run must not be offered without audit');
      assert.strictEqual(gate.metadata.classifiedDecision, 'review');
      assert.strictEqual(optimizeCalls, 0);
    } finally {
      managed.cli.kernel.recordCliMutationAudit = original;
      managed.cli.kernel.optimize = originalOptimize;
      managed.close();
    }
  });


  it('brackets a direct execute kaydet with attempted and committed audits', () => {
    // This case previously expected 'Unknown command.' and no persist, which
    // never held: the whole file was exiting early (see createInteractiveHarness)
    // so nothing here ran. `kaydet` does persist, and it is audited on both
    // sides of the write.
    const managed = createIsolatedCli();
    const capture = captureKernelAudit(managed.cli);
    const originalPersist = managed.cli.kernel.persist;
    const order = [];
    managed.cli.kernel.persist = () => { order.push('persist'); };
    try {
      const intent = { sourceCommand: 'kaydet', mutationType: 'persistence', eventType: 'UPDATE', decision: 'allow', executionEligible: true, reason: 'cli_persist_local' };
      capture.onCall = call => order.push(`audit:${call.phase}`);

      assert.strictEqual(managed.cli.execute('kaydet', ''), 'Memory saved.');
      assert.deepStrictEqual(order, ['audit:attempted', 'persist', 'audit:committed']);
      assert.strictEqual(capture.calls.length, 2);
      assert.deepStrictEqual(capture.calls[0], expectedIntent(intent));
      assert.deepStrictEqual(capture.calls[1], expectedIntent({ ...intent, phase: 'committed' }));
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
        'audit:kaydet:attempted',
        'persist',
        'audit:kaydet:committed',
        'log:Memory saved.',
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
          `audit:${sourceCommand}:attempted`,
          'persist',
          `audit:${sourceCommand}:committed`,
          'log:Memory saved. Goodbye.',
          'close',
          'exit:0',
        ]);
      } finally {
        harness.restore();
        managed.close();
      }
    });
  }

  // #760: the interactive save is the same mutation as the one-shot save, so
  // it fails closed on the same terms -- an unavailable audit sink stops the
  // write instead of persisting without evidence.
  for (const [mode, errorCode] of [['missing', 'AUDIT_SINK_UNAVAILABLE'], ['throwing', 'AUDIT_WRITE_FAILED']]) {
    it(`refuses the interactive save with a ${mode} audit seam`, async () => {
      const managed = createIsolatedCli();
      const harness = createInteractiveHarness(managed.cli, mode);
      try {
        await harness.line('kaydet');
        const nonAuditEvents = harness.events.filter(event => !event.startsWith('audit:'));
        assert.deepStrictEqual(nonAuditEvents, [
          `log:Kaydetme durduruldu: denetim kaydi yazilamadi (${errorCode}).`,
          'prompt',
        ]);
      } finally {
        harness.restore();
        managed.close();
      }
    });

    it(`still exits, without an unaudited save, with a ${mode} audit seam`, async () => {
      const managed = createIsolatedCli();
      const harness = createInteractiveHarness(managed.cli, mode);
      try {
        await harness.line('exit');
        const nonAuditEvents = harness.events.filter(event => !event.startsWith('audit:'));
        assert.deepStrictEqual(nonAuditEvents, [
          `log:Kaydetmeden cikiliyor: denetim kaydi yazilamadi (${errorCode}).`,
          'close',
          'exit:0',
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
    const managed = createIsolatedCli({ useSQLite: true });
    const originalAudit = managed.cli.kernel.recordCliMutationAudit;
    const originalOptions = managed.cli._backupOptions;
    const originalReload = managed.cli.kernel.reload;
    const stages = [];
    try {
      managed.cli.agent.storage.close();
      managed.cli.kernel.persist();
      managed.cli.kernel.recordCliMutationAudit = intent => {
        stages.push(`audit:${intent.sourceCommand}:${intent.phase}`);
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
      assert.match(backupResult, /^Backup complete:/);
      assert.deepStrictEqual(stages, [
        'audit:backup:attempted',
        'command:backup',
        'audit:backup:committed',
      ]);

      stages.length = 0;
      const restoreResult = managed.cli.execute('restore', '');
      assert.match(restoreResult, /^Restore tamamlandi:/);
      assert.deepStrictEqual(stages, [
        'audit:restore:attempted',
        'command:restore',
        'reload',
        'audit:restore:committed',
      ]);
    } finally {
      managed.cli.kernel.recordCliMutationAudit = originalAudit;
      managed.cli._backupOptions = originalOptions;
      managed.cli.kernel.reload = originalReload;
      managed.close();
    }
  });
});
