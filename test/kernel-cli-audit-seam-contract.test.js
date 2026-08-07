const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');
const { withoutNestedMember, kernelClassBody } = require('./helpers/kernel-declaration');

const MAPPINGS = Object.freeze([
  ['kaydet', 'persistence', 'UPDATE', 'allow', true, 'cli_persist_local'],
  ['exit', 'persistence', 'UPDATE', 'allow', true, 'cli_persist_local'],
  ['cikis', 'persistence', 'UPDATE', 'allow', true, 'cli_persist_local'],
  ['backup', 'export', 'EXPORTED', 'allow', true, 'cli_backup_export_local'],
  ['restore', 'state_replace', 'IMPORTED', 'allow', true, 'cli_restore_state_replace_local'],
  ['optimize', 'canonical', 'REVIEW', 'review', false, 'cli_canonical_mutation_requires_review'],
  ['evolve', 'canonical', 'REVIEW', 'review', false, 'cli_canonical_mutation_requires_review'],
  ['konsolide', 'canonical', 'REVIEW', 'review', false, 'cli_canonical_mutation_requires_review'],
  ['dusun', 'automation', 'REVIEW', 'review', false, 'cli_automation_requires_review'],
]);

const FAILURE = Object.freeze({
  auditRecorded: false,
  event: null,
  errorCode: 'AUDIT_WRITE_FAILED',
});

function intentFrom(mapping, extra = {}) {
  return {
    sourceCommand: mapping[0],
    mutationType: mapping[1],
    eventType: mapping[2],
    decision: mapping[3],
    executionEligible: mapping[4],
    reason: mapping[5],
    ...extra,
  };
}

function validIntent(extra = {}) {
  return intentFrom(MAPPINGS[3], extra);
}

function makeKernel(label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-cli-audit-seam-${label}-`));
  const kernel = new Kernel({
    noLoad: true,
    loadPlugins: false,
    useSQLite: false,
    memoryStoreUseSQLite: false,
    memoryPath: path.join(root, 'memory.json'),
    dbPath: path.join(root, 'memory.db'),
    memoryStorePath: path.join(root, 'memory-store.json'),
    memoryStoreDbPath: path.join(root, 'memory-store.db'),
  });

  return {
    kernel,
    dispose() {
      kernel.graph.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

function expectedRawEvent(intent) {
  return {
    eventType: intent.eventType,
    targetType: 'cli_mutation',
    targetId: intent.sourceCommand,
    actor: intent.actor?.trim() || 'cli-user',
    workspaceId: intent.workspaceId?.trim() || 'default',
    details: {
      source: 'cli',
      command: intent.sourceCommand,
      mutationType: intent.mutationType,
      decision: intent.decision,
      executed: intent.executionEligible,
      reason: intent.reason,
      ...(intent.approvalState === undefined ? {} : { approvalState: intent.approvalState }),
      ...(intent.receiptReference === undefined ? {} : { receiptId: intent.receiptReference.trim() }),
    },
  };
}

test('Kernel v1 and KernelV2 expose a synchronous CLI audit seam', () => {
  const managed = makeKernel('existence');
  const v2 = new KernelV2({ kernel: managed.kernel });

  try {
    assert.equal(typeof managed.kernel.recordCliMutationAudit, 'function');
    assert.equal(typeof v2.recordCliMutationAudit, 'function');

    const v1Result = managed.kernel.recordCliMutationAudit(validIntent());
    const v2Result = v2.recordCliMutationAudit(validIntent());
    assert.equal(typeof v1Result?.then, 'undefined');
    assert.equal(typeof v2Result?.then, 'undefined');
  } finally {
    managed.dispose();
  }
});

test('accepts only the nine exact mappings and appends each bounded event once', () => {
  const managed = makeKernel('mappings');
  const originalAppend = managed.kernel.graph.appendAuditEvent;
  const calls = [];

  try {
    managed.kernel.graph.appendAuditEvent = (...args) => {
      calls.push(args);
      return { normalized: calls.length };
    };

    for (const mapping of MAPPINGS) {
      const intent = intentFrom(mapping);
      const result = managed.kernel.recordCliMutationAudit(intent);
      assert.deepEqual(calls.at(-1), [expectedRawEvent(intent)]);
      assert.deepEqual(result, {
        auditRecorded: true,
        event: { normalized: calls.length },
        errorCode: null,
      });
    }

    assert.equal(calls.length, MAPPINGS.length);
  } finally {
    managed.kernel.graph.appendAuditEvent = originalAppend;
    managed.dispose();
  }
});

test('maps trimmed optional fields without emitting absent optional detail keys', () => {
  const managed = makeKernel('optional');
  const originalAppend = managed.kernel.graph.appendAuditEvent;
  const calls = [];

  try {
    managed.kernel.graph.appendAuditEvent = (event) => {
      calls.push(event);
      return { ...event, auditId: 'normalized' };
    };

    const defaults = managed.kernel.recordCliMutationAudit(validIntent());
    assert.equal(defaults.auditRecorded, true);
    assert.equal(Object.hasOwn(calls[0].details, 'approvalState'), false);
    assert.equal(Object.hasOwn(calls[0].details, 'receiptId'), false);

    const supplied = validIntent({
      actor: '  operator-1  ',
      workspaceId: '  workspace-1  ',
      approvalState: 'approved',
      receiptReference: '  receipt-1  ',
    });
    const result = managed.kernel.recordCliMutationAudit(supplied);
    assert.equal(result.auditRecorded, true);
    assert.deepEqual(calls[1], expectedRawEvent(supplied));
  } finally {
    managed.kernel.graph.appendAuditEvent = originalAppend;
    managed.dispose();
  }
});

test('rejects every forbidden or unknown top-level field without append', () => {
  const managed = makeKernel('forbidden');
  const originalAppend = managed.kernel.graph.appendAuditEvent;
  let appendCount = 0;
  const fields = [
    'auditId',
    'timestamp',
    'targetType',
    'targetId',
    'sourceRef',
    'provenanceId',
    'trustPolicyVersion',
    'details',
    'provenance',
    'receipt',
    'approval',
    'graphOptions',
    'opts',
    'unexpected',
  ];

  try {
    managed.kernel.graph.appendAuditEvent = () => {
      appendCount += 1;
      return {};
    };

    for (const field of fields) {
      assert.deepEqual(managed.kernel.recordCliMutationAudit(validIntent({ [field]: 'forbidden' })), FAILURE);
    }
    const symbolIntent = validIntent();
    symbolIntent[Symbol('unknown')] = true;
    assert.deepEqual(managed.kernel.recordCliMutationAudit(symbolIntent), FAILURE);

    const nonEnumerableInputs = [
      ['auditId', 'caller-controlled'],
      ['unexpected', true],
      [Symbol('unknown'), true],
    ];
    for (const [key, value] of nonEnumerableInputs) {
      const intent = validIntent();
      Object.defineProperty(intent, key, { value, enumerable: false });
      let result;
      assert.doesNotThrow(() => {
        result = managed.kernel.recordCliMutationAudit(intent);
      });
      assert.deepEqual(result, FAILURE);
    }
    assert.equal(appendCount, 0);
  } finally {
    managed.kernel.graph.appendAuditEvent = originalAppend;
    managed.dispose();
  }
});

test('rejects invalid input shapes and field values without append', () => {
  const managed = makeKernel('invalid-shapes');
  const originalAppend = managed.kernel.graph.appendAuditEvent;
  let appendCount = 0;
  const invalidInputs = [
    undefined,
    null,
    [],
    'backup',
    {},
    (() => {
      const input = validIntent();
      delete input.reason;
      return input;
    })(),
    { ...validIntent(), sourceCommand: undefined },
    { ...validIntent(), mutationType: 1 },
    { ...validIntent(), eventType: false },
    { ...validIntent(), decision: null },
    { ...validIntent(), executionEligible: 'true' },
    { ...validIntent(), reason: [] },
    { ...validIntent(), actor: '   ' },
    { ...validIntent(), workspaceId: '' },
    { ...validIntent(), receiptReference: '  ' },
    { ...validIntent(), approvalState: 'unknown' },
  ];

  try {
    managed.kernel.graph.appendAuditEvent = () => {
      appendCount += 1;
      return {};
    };
    for (const input of invalidInputs) {
      assert.deepEqual(managed.kernel.recordCliMutationAudit(input), FAILURE);
    }
    assert.equal(appendCount, 0);
  } finally {
    managed.kernel.graph.appendAuditEvent = originalAppend;
    managed.dispose();
  }
});

test('rejects mismatched mapping combinations without append', () => {
  const managed = makeKernel('invalid-combinations');
  const originalAppend = managed.kernel.graph.appendAuditEvent;
  let appendCount = 0;
  const invalidInputs = [
    { ...validIntent(), eventType: 'UPDATE' },
    { ...validIntent(), decision: 'review' },
    { ...validIntent(), executionEligible: false },
    { ...validIntent(), mutationType: 'canonical' },
    { ...validIntent(), reason: 'cli_persist_local' },
    { ...intentFrom(MAPPINGS[8]), decision: 'allow' },
    { ...intentFrom(MAPPINGS[0]), eventType: 'REVIEW' },
    { ...validIntent(), sourceCommand: 'unknown' },
    { ...intentFrom(MAPPINGS[8]), sourceCommand: 'düşün' },
  ];

  try {
    managed.kernel.graph.appendAuditEvent = () => {
      appendCount += 1;
      return {};
    };
    for (const input of invalidInputs) {
      assert.deepEqual(managed.kernel.recordCliMutationAudit(input), FAILURE);
    }
    assert.equal(appendCount, 0);
  } finally {
    managed.kernel.graph.appendAuditEvent = originalAppend;
    managed.dispose();
  }
});

test('returns the real Graph-normalized bounded event without durability claims', () => {
  const managed = makeKernel('normalization');

  try {
    const result = managed.kernel.recordCliMutationAudit(validIntent());
    assert.equal(result.auditRecorded, true);
    assert.equal(result.errorCode, null);
    assert.equal(typeof result.event.auditId, 'string');
    assert.notEqual(result.event.auditId, '');
    assert.equal(typeof result.event.timestamp, 'string');
    assert.notEqual(result.event.timestamp, '');
    assert.equal(result.event.workspaceId, 'default');
    assert.equal(result.event.actor, 'cli-user');
    assert.equal(result.event.sourceRef, '');
    assert.equal(result.event.provenanceId, '');
    assert.equal(result.event.trustPolicyVersion, '');
    assert.equal(result.event.targetType, 'cli_mutation');
    assert.equal(result.event.targetId, 'backup');
    assert.deepEqual(result.event.details, expectedRawEvent(validIntent()).details);
  } finally {
    managed.dispose();
  }
});

test('isolates missing and throwing append surfaces with the exact failure result', () => {
  const managed = makeKernel('append-failure');
  const originalAppend = managed.kernel.graph.appendAuditEvent;

  try {
    managed.kernel.graph.appendAuditEvent = undefined;
    assert.deepEqual(managed.kernel.recordCliMutationAudit(validIntent()), FAILURE);

    const sentinel = new Error('sentinel audit failure');
    let attempts = 0;
    managed.kernel.graph.appendAuditEvent = () => {
      attempts += 1;
      throw sentinel;
    };
    let result;
    assert.doesNotThrow(() => {
      result = managed.kernel.recordCliMutationAudit(validIntent());
    });
    assert.deepEqual(result, FAILURE);
    assert.equal(attempts, 1);
  } finally {
    managed.kernel.graph.appendAuditEvent = originalAppend;
    managed.dispose();
  }
});

test('rejects invalid and Promise-like append returns synchronously', () => {
  const managed = makeKernel('invalid-return');
  const originalAppend = managed.kernel.graph.appendAuditEvent;
  const returns = [null, 1, 'event', [], Promise.resolve({}), { then() {} }];

  try {
    for (const value of returns) {
      let attempts = 0;
      managed.kernel.graph.appendAuditEvent = () => {
        attempts += 1;
        return value;
      };
      const result = managed.kernel.recordCliMutationAudit(validIntent());
      assert.deepEqual(result, FAILURE);
      assert.equal(typeof result?.then, 'undefined');
      assert.equal(attempts, 1);
    }
  } finally {
    managed.kernel.graph.appendAuditEvent = originalAppend;
    managed.dispose();
  }
});

test('KernelV2 delegates once with the same intent and returns the same result', () => {
  const managed = makeKernel('v2-delegation');
  const v2 = new KernelV2({ kernel: managed.kernel });
  const originalMethod = managed.kernel.recordCliMutationAudit;
  const originalAppend = managed.kernel.graph.appendAuditEvent;
  const intent = validIntent();
  const sentinelResult = Object.freeze({ auditRecorded: true, event: {}, errorCode: null });
  let delegationCount = 0;
  let appendCount = 0;

  try {
    managed.kernel.recordCliMutationAudit = (received) => {
      delegationCount += 1;
      assert.equal(received, intent);
      return sentinelResult;
    };
    managed.kernel.graph.appendAuditEvent = () => {
      appendCount += 1;
      return {};
    };

    const result = v2.recordCliMutationAudit(intent);
    assert.equal(result, sentinelResult);
    assert.equal(delegationCount, 1);
    assert.equal(appendCount, 0);
  } finally {
    managed.kernel.recordCliMutationAudit = originalMethod;
    managed.kernel.graph.appendAuditEvent = originalAppend;
    managed.dispose();
  }
});

test('does not expose a generic public audit append surface', () => {
  const managed = makeKernel('negative-surface');
  const kernelDeclaration = fs.readFileSync(path.join(__dirname, '..', 'kernel.d.ts'), 'utf8');
  const v2Declaration = fs.readFileSync(path.join(__dirname, '..', 'kernel.v2.d.ts'), 'utf8');

  try {
    // The runtime guarantee: the Kernel exposes no public append, only the
    // private seam.
    assert.equal(managed.kernel.appendAuditEvent, undefined);
    assert.equal(typeof managed.kernel._appendAuditEvent, 'function');

    // The declaration guarantee, stated per surface. kernel.graph
    // .appendAuditEvent is a real method (graph.js defines it, agent.v3.js
    // calls it), so the graph typing describes it on purpose; asserting over
    // the whole file conflated the graph's surface with the Kernel's own.
    const kernelOwnSurface = withoutNestedMember(kernelClassBody(kernelDeclaration), 'graph');
    assert.doesNotMatch(kernelOwnSurface, /\bappendAuditEvent\s*\(/,
      'Kernel itself must not declare a public audit append');
    assert.doesNotMatch(kernelDeclaration, /\b_appendAuditEvent\s*\(/,
      'the private seam must never be declared as API');
    assert.doesNotMatch(withoutNestedMember(v2Declaration, 'graph'), /\bappendAuditEvent\s*\(/,
      'KernelV2 must not declare one either');
  } finally {
    managed.dispose();
  }
});
