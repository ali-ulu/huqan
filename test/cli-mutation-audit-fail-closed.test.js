'use strict';

/**
 * The CLI mutation gate fails closed when its audit cannot be written (#760).
 *
 * `_evaluateCliMutationGate` promises that a classified mutation is never run
 * unaudited, but the audit call discarded every failure the kernel reported --
 * an unavailable writer, a rejected intent, a non-durable result -- and then
 * returned `allow` anyway. `restore` was the sharpest case: canonical
 * persistence was replaced and the kernel reloaded with no durable record that
 * it happened.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const CLI = require('../cli');
const {
  CLI_MUTATION_GATE,
  evaluateCliMutationGate,
  commitCliMutation,
} = require('../lib/cli-mutation-gate');
const { validateCliMutationAuditIntent } = require('../lib/cli-mutation-audit-intent');

function createCli() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-cli-fail-closed-'));
  const cli = new CLI({
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
  return {
    cli,
    close() {
      try { cli.agent?.storage?.close?.(); } catch (_) {}
      try { cli.kernel?.graph?.close?.(); } catch (_) {}
      try { cli.kernel?.memory?.close?.(); } catch (_) {}
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A kernel whose audit seam reports the given failure. */
function kernelWithAudit(behavior) {
  const calls = [];
  return {
    calls,
    recordCliMutationAudit: behavior === 'absent' ? undefined : (intent) => {
      calls.push(intent);
      if (behavior === 'throws') throw new Error('audit sink down');
      if (behavior === 'reports-failure') {
        return { auditRecorded: false, event: null, errorCode: 'AUDIT_WRITE_FAILED' };
      }
      if (behavior === 'promise') return { auditRecorded: true, event: Promise.resolve({}) };
      return { auditRecorded: true, event: {}, errorCode: null };
    },
  };
}

const MUTATION_COMMANDS = ['kaydet', 'backup', 'restore', 'quickstart', 'optimize', 'evolve', 'konsolide'];

describe('an unwritable audit blocks the mutation it was meant to record (#760)', () => {
  for (const behavior of ['absent', 'throws', 'reports-failure']) {
    it(`blocks every mutation command when the audit seam ${behavior}`, () => {
      const kernel = kernelWithAudit(behavior);
      for (const command of MUTATION_COMMANDS) {
        const gate = evaluateCliMutationGate({ kernel, command, args: '' });
        assert.strictEqual(gate.canExecute, false, `${command} ran with no audit record`);
        assert.strictEqual(gate.allowed, false);
        assert.strictEqual(gate.decision, 'block');
        assert.strictEqual(gate.reason, 'cli_audit_write_failed');
        assert.strictEqual(gate.metadata.auditRecorded, false);
        assert.ok(gate.metadata.auditErrorCode, `${command} blocked without saying why`);
      }
    });
  }

  it('reports the classified decision for allowed and unavailable commands', () => {
    const kernel = kernelWithAudit('throws');
    assert.strictEqual(
      evaluateCliMutationGate({ kernel, command: 'restore', args: '' }).metadata.classifiedDecision,
      'allow',
    );
    assert.strictEqual(
      evaluateCliMutationGate({ kernel, command: 'optimize', args: '' }).metadata.classifiedDecision,
      'block',
    );
  });

  it('treats a non-durable (pending) audit event as unwritten', () => {
    // A promise means the event is not on disk yet, which is precisely what
    // the caller must not assume; kernel.recordCliMutationAudit rejects it.
    const kernel = {
      recordCliMutationAudit: (intent) => require('../lib/cli-mutation-audit').recordCliMutationAudit({
        appendAuditEvent: () => Promise.resolve({ auditId: 'later' }),
      }, intent),
    };
    const gate = evaluateCliMutationGate({ kernel, command: 'restore', args: '' });
    assert.strictEqual(gate.canExecute, false);
    assert.strictEqual(gate.metadata.auditErrorCode, 'AUDIT_WRITE_FAILED');
  });

  it('lets read-only and control commands through with no audit sink at all', () => {
    const kernel = kernelWithAudit('absent');
    // Not classified as mutations: no audit is owed, so nothing is withheld.
    assert.strictEqual(evaluateCliMutationGate({ kernel, command: 'durum', args: '' }), null);
    assert.strictEqual(evaluateCliMutationGate({ kernel, command: 'sor', args: 'kedi nedir' }), null);
    // 'düşün dur' stops automation; classified, but mutationType 'none'.
    const stop = evaluateCliMutationGate({ kernel, command: 'dusun', args: 'dur' });
    assert.strictEqual(stop.canExecute, true);
    assert.strictEqual(kernel.calls.length, 0);
  });

  it('keeps an unavailable command explicitly blocked rather than promoting it', () => {
    const kernel = kernelWithAudit('records');
    const gate = evaluateCliMutationGate({ kernel, command: 'evolve', args: '' });
    assert.strictEqual(gate.decision, 'block');
    assert.strictEqual(gate.canExecute, false);
    assert.strictEqual(gate.canDryRun, false);
  });
});

describe('the CLI surfaces the block instead of mutating (#760)', () => {
  it('refuses restore, and does not reload the kernel', () => {
    const managed = createCli();
    let reloads = 0;
    try {
      managed.cli.kernel.reload = () => { reloads += 1; };
      managed.cli.kernel.recordCliMutationAudit = () => ({ auditRecorded: false, errorCode: 'AUDIT_WRITE_FAILED' });

      const output = managed.cli.execute('restore', '');
      assert.match(output, /engellendi/);
      assert.match(output, /cli_audit_write_failed/);
      assert.strictEqual(reloads, 0, 'canonical state was replaced without an audit record');
    } finally {
      managed.close();
    }
  });

  it('refuses backup, and writes no backup directory', () => {
    const managed = createCli();
    let backups = 0;
    try {
      managed.cli._backupOptions = () => { backups += 1; return {}; };
      managed.cli.kernel.recordCliMutationAudit = () => ({ auditRecorded: false, errorCode: 'AUDIT_WRITE_FAILED' });

      assert.match(managed.cli.execute('backup', ''), /engellendi/);
      assert.strictEqual(backups, 0);
    } finally {
      managed.close();
    }
  });
});

describe('committed audit events (#760)', () => {
  it('quickstart has an audit mapping, so its audit can be written at all', () => {
    // The CLI gated and audited quickstart, but it was missing from the
    // mapping table, so every one of its audit intents was rejected as unknown.
    const intent = {
      sourceCommand: 'quickstart',
      mutationType: 'demo_sandbox',
      eventType: 'UPDATE',
      decision: 'allow',
      executionEligible: true,
      reason: 'cli_quickstart_isolated_demo_store',
    };
    assert.ok(validateCliMutationAuditIntent(intent), 'quickstart audit intents are still rejected');
  });

  it('marks the pre-execution event attempted and the post-execution one committed', () => {
    const kernel = kernelWithAudit('records');
    evaluateCliMutationGate({ kernel, command: 'backup', args: '' });
    commitCliMutation(kernel, 'backup');

    assert.deepStrictEqual(kernel.calls.map(intent => intent.phase), ['attempted', 'committed']);
  });

  it('a rejected phase is not written at all', () => {
    assert.strictEqual(validateCliMutationAuditIntent({
      sourceCommand: 'backup',
      mutationType: 'export',
      eventType: 'EXPORTED',
      decision: 'allow',
      executionEligible: true,
      reason: 'cli_backup_export_local',
      phase: 'probably-committed',
    }), null);
  });

  it('a failed commit audit is reported, not swallowed, and does not undo the mutation', () => {
    const managed = createCli();
    try {
      let calls = 0;
      managed.cli.kernel.recordCliMutationAudit = (intent) => {
        calls += 1;
        return intent.phase === 'committed'
          ? { auditRecorded: false, errorCode: 'AUDIT_WRITE_FAILED' }
          : { auditRecorded: true, event: {}, errorCode: null };
      };
      const output = managed.cli.execute('kaydet', '');
      assert.match(output, /^Memory saved\./, 'the mutation itself must still be reported');
      assert.match(output, /commit denetim kaydi yazilamadi/);
      assert.strictEqual(calls, 2);
    } finally {
      managed.close();
    }
  });

  it('every classified mutation command has a mapping the validator accepts', () => {
    for (const [command, classification] of Object.entries(CLI_MUTATION_GATE)) {
      if (classification.mutationType === 'none') continue;
      for (const phase of ['attempted', 'committed']) {
        assert.ok(validateCliMutationAuditIntent({
          sourceCommand: command,
          mutationType: classification.mutationType,
          eventType: classification.auditEvent,
          decision: classification.decision,
          executionEligible: classification.decision === 'allow',
          reason: classification.reason,
          phase,
        }), `${command} (${phase}) has no accepted audit mapping, so it can never be audited`);
      }
    }
  });
});
