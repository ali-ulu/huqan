'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  observeFile,
  compareObservations,
  isObserved,
  FILE_STATES,
  EFFECT_OBSERVATIONS,
  MAX_OBSERVED_BYTES,
} = require('../lib/file-effect-sensor');
const { evaluateExternalAction, recordExternalActionOutcome } = require('../lib/external-action-guard');

function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-effect-'));
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Run one action through the guard and mutate (or not) between the readings. */
function act(dir, filePath, mutate, reportedStatus) {
  const envelope = {
    invocationId: `effect-${Math.random().toString(36).slice(2)}`,
    agentName: 'test-agent',
    sessionId: 'session',
    toolName: 'Write',
    args: { file_path: filePath },
    cwd: dir,
    workspaceRoot: dir,
  };
  const writer = { append() {} };
  const admission = evaluateExternalAction(envelope, { receiptWriter: writer });
  mutate();
  return recordExternalActionOutcome(envelope, admission.receipt,
    { status: reportedStatus }, { receiptWriter: writer }).receipt.metadata;
}

// ─── what the field is for ───────────────────────────────────────────────────

test('a reported success that changed nothing is recorded as unchanged', () => {
  // The whole reason this sensor exists. Before it, an executor could report
  // success on an action that did nothing and the receipt would say `executed`
  // with no way to tell. Now the receipt says HUQAN looked, and what it saw.
  const { dir, cleanup } = workspace();
  try {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'v1');
    const metadata = act(dir, file, () => {}, 'success');
    assert.equal(metadata.outcomeStatus, 'executed', 'the caller still reported success');
    assert.equal(metadata.effectVerification, 'observed');
    assert.equal(metadata.fileEffect.observation, EFFECT_OBSERVATIONS.UNCHANGED);
  } finally {
    cleanup();
  }
});

test('creation, modification and removal are each observed', () => {
  const { dir, cleanup } = workspace();
  try {
    const file = path.join(dir, 'a.txt');
    assert.equal(act(dir, file, () => fs.writeFileSync(file, 'v1'), 'success').fileEffect.observation,
      EFFECT_OBSERVATIONS.CREATED);
    assert.equal(act(dir, file, () => fs.writeFileSync(file, 'v2'), 'success').fileEffect.observation,
      EFFECT_OBSERVATIONS.MODIFIED);
    assert.equal(act(dir, file, () => fs.rmSync(file), 'success').fileEffect.observation,
      EFFECT_OBSERVATIONS.REMOVED);
  } finally {
    cleanup();
  }
});

test('an action with no file target stays reported', () => {
  // Honesty in the other direction: a command the sensor cannot see must not
  // be dressed up as observed.
  const { dir, cleanup } = workspace();
  try {
    const envelope = {
      invocationId: 'no-target',
      agentName: 'test-agent',
      sessionId: 'session',
      toolName: 'Bash',
      args: { command: 'echo hi' },
      cwd: dir,
      workspaceRoot: dir,
    };
    const writer = { append() {} };
    const admission = evaluateExternalAction(envelope, { receiptWriter: writer });
    const metadata = recordExternalActionOutcome(envelope, admission.receipt,
      { status: 'success' }, { receiptWriter: writer }).receipt.metadata;
    assert.equal(metadata.effectVerification, 'reported');
    assert.equal(metadata.fileEffect, null);
  } finally {
    cleanup();
  }
});

test('a blocked action claims no verification at all', () => {
  const { dir, cleanup } = workspace();
  try {
    const file = path.join(dir, 'a.txt');
    assert.equal(act(dir, file, () => {}, 'blocked').effectVerification, 'none');
  } finally {
    cleanup();
  }
});

// ─── never claiming more than was measured ───────────────────────────────────

test('an observation that could not be taken is not reported as one that was', () => {
  // `indeterminate` must fall back to `reported`. Anything else would let a
  // failed measurement look like a successful one -- the exact confusion the
  // field exists to remove.
  for (const [before, after] of [
    [{ state: FILE_STATES.UNREADABLE }, { state: FILE_STATES.DIGESTED, digest: 'a' }],
    [{ state: FILE_STATES.DIGESTED, digest: 'a' }, { state: FILE_STATES.TOO_LARGE }],
    [{ state: FILE_STATES.TOO_LARGE }, { state: FILE_STATES.TOO_LARGE }],
    [null, { state: FILE_STATES.DIGESTED, digest: 'a' }],
  ]) {
    const observation = compareObservations(before, after);
    assert.equal(observation, EFFECT_OBSERVATIONS.INDETERMINATE);
    assert.equal(isObserved(observation), false);
  }
});

test('a file too large to digest is refused rather than half-read', () => {
  // Hashing an arbitrarily large file on the admission path would turn an
  // observation into a stall, and a partial digest would be worse than none.
  const { dir, cleanup } = workspace();
  try {
    const file = path.join(dir, 'big.bin');
    fs.writeFileSync(file, Buffer.alloc(MAX_OBSERVED_BYTES + 1));
    const reading = observeFile(file);
    assert.equal(reading.state, FILE_STATES.TOO_LARGE);
    assert.equal(reading.digest, null);
  } finally {
    cleanup();
  }
});

test('the sensor never throws, whatever it is pointed at', () => {
  // It runs on the admission path. A sensor that can fail the action it
  // measures is worse than no sensor.
  const { dir, cleanup } = workspace();
  try {
    for (const target of [dir, '', null, undefined, 42, path.join(dir, 'nope.txt'), '\u0000bad']) {
      assert.doesNotThrow(() => observeFile(target), String(target));
    }
    assert.equal(observeFile(path.join(dir, 'nope.txt')).state, FILE_STATES.ABSENT);
    assert.equal(observeFile(dir).state, FILE_STATES.UNREADABLE, 'a directory is not a file');
  } finally {
    cleanup();
  }
});

test('an absent file that stays absent is unchanged, not created', () => {
  const { dir, cleanup } = workspace();
  try {
    const file = path.join(dir, 'never.txt');
    assert.equal(act(dir, file, () => {}, 'success').fileEffect.observation, EFFECT_OBSERVATIONS.UNCHANGED);
  } finally {
    cleanup();
  }
});

test('an outcome recorded against an older receipt still works', () => {
  // A receipt written before this sensor existed carries no first reading.
  // That must degrade to `reported`, not crash the outcome path.
  const { dir, cleanup } = workspace();
  try {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'v1');
    const envelope = {
      invocationId: 'legacy',
      agentName: 'test-agent',
      sessionId: 'session',
      toolName: 'Write',
      args: { file_path: file },
      cwd: dir,
      workspaceRoot: dir,
    };
    const writer = { append() {} };
    const admission = evaluateExternalAction(envelope, { receiptWriter: writer });
    const legacy = { ...admission.receipt, metadata: { ...admission.receipt.metadata, fileBefore: null } };
    const metadata = recordExternalActionOutcome(envelope, legacy,
      { status: 'success' }, { receiptWriter: writer }).receipt.metadata;
    assert.equal(metadata.effectVerification, 'reported');
    assert.equal(metadata.fileEffect, null);
  } finally {
    cleanup();
  }
});

test('the receipt carries the readings, not the file contents', () => {
  // A digest is evidence; the bytes are the payload, and an append-only audit
  // file is the wrong place for them.
  const { dir, cleanup } = workspace();
  try {
    const file = path.join(dir, 'secret.txt');
    const secret = 'vatandas verisi 10000000146';
    const metadata = act(dir, file, () => fs.writeFileSync(file, secret), 'success');
    assert.match(metadata.fileEffect.after.digest, /^[0-9a-f]{64}$/);
    assert.ok(!JSON.stringify(metadata).includes(secret), 'file contents must not reach the receipt');
  } finally {
    cleanup();
  }
});

// ─── relative targets resolve against the action cwd (#1865) ────────────────

/** Same as act() but the envelope names the file relative to the action cwd. */
function actRelative(dir, name, mutate, reportedStatus) {
  const envelope = {
    invocationId: `effect-rel-${Math.random().toString(36).slice(2)}`,
    agentName: 'test-agent',
    sessionId: 'session',
    toolName: 'Write',
    args: { file_path: name },
    cwd: dir,
    workspaceRoot: dir,
  };
  const writer = { append() {} };
  const admission = evaluateExternalAction(envelope, { receiptWriter: writer });
  mutate();
  const outcome = recordExternalActionOutcome(envelope, admission.receipt,
    { status: reportedStatus }, { receiptWriter: writer });
  return { admission: admission.receipt, metadata: outcome.receipt.metadata };
}

test('a relative target is measured against the action cwd, not the guard process', () => {
  // The guard process runs from its own cwd; a relative target resolved there
  // would observe a file that does not exist and report `unchanged` while the
  // real file changed.
  const { dir, cleanup } = workspace();
  try {
    const name = 'rel.txt';
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'v1');
    const { admission, metadata } = actRelative(dir, name, () => fs.writeFileSync(file, 'v2'), 'success');
    assert.equal(metadata.fileEffect.observation, EFFECT_OBSERVATIONS.MODIFIED);
    assert.equal(metadata.effectVerification, 'observed');
    assert.equal(admission.metadata.fileTarget, file, 'admission pins the resolved target');
  } finally {
    cleanup();
  }
});

test('relative and absolute spellings of one file agree', () => {
  const { dir, cleanup } = workspace();
  try {
    const name = 'same.txt';
    const file = path.join(dir, name);
    fs.writeFileSync(file, 'v1');
    const viaRelative = actRelative(dir, name, () => fs.writeFileSync(file, 'v2'), 'success').metadata;
    fs.writeFileSync(file, 'v1');
    const viaAbsolute = act(dir, file, () => fs.writeFileSync(file, 'v2'), 'success');
    assert.equal(viaRelative.fileEffect.observation, viaAbsolute.fileEffect.observation);
    assert.equal(viaRelative.effectVerification, viaAbsolute.effectVerification);
    assert.equal(viaRelative.fileEffect.after.digest, viaAbsolute.fileEffect.after.digest);
  } finally {
    cleanup();
  }
});

test('relative create, remove and stay-absent are each observed', () => {
  const { dir, cleanup } = workspace();
  try {
    const name = 'cycle.txt';
    const file = path.join(dir, name);
    assert.equal(
      actRelative(dir, name, () => fs.writeFileSync(file, 'v1'), 'success').metadata.fileEffect.observation,
      EFFECT_OBSERVATIONS.CREATED);
    assert.equal(
      actRelative(dir, name, () => fs.rmSync(file), 'success').metadata.fileEffect.observation,
      EFFECT_OBSERVATIONS.REMOVED);
    assert.equal(
      actRelative(dir, 'never.txt', () => {}, 'success').metadata.fileEffect.observation,
      EFFECT_OBSERVATIONS.UNCHANGED);
  } finally {
    cleanup();
  }
});

test('an unreadable relative target stays reported', () => {
  // A directory is not a file: both readings are `unreadable`, the comparison
  // is `indeterminate`, and the receipt must say `reported`.
  const { dir, cleanup } = workspace();
  try {
    const metadata = actRelative(dir, '.', () => {}, 'success').metadata;
    assert.equal(metadata.fileEffect.observation, EFFECT_OBSERVATIONS.INDETERMINATE);
    assert.equal(metadata.effectVerification, 'reported');
  } finally {
    cleanup();
  }
});

test('an outcome against a receipt from before target pinning still measures', () => {
  // Compat: a receipt carrying a first reading but no fileTarget falls back to
  // the envelope's resolved path rather than degrading to `reported`.
  const { dir, cleanup } = workspace();
  try {
    const file = path.join(dir, 'a.txt');
    fs.writeFileSync(file, 'v1');
    const envelope = {
      invocationId: 'pre-pinning',
      agentName: 'test-agent',
      sessionId: 'session',
      toolName: 'Write',
      args: { file_path: file },
      cwd: dir,
      workspaceRoot: dir,
    };
    const writer = { append() {} };
    const admission = evaluateExternalAction(envelope, { receiptWriter: writer });
    const legacy = {
      ...admission.receipt,
      metadata: { ...admission.receipt.metadata, fileTarget: undefined },
    };
    fs.writeFileSync(file, 'v2');
    const metadata = recordExternalActionOutcome(envelope, legacy,
      { status: 'success' }, { receiptWriter: writer }).receipt.metadata;
    assert.equal(metadata.fileEffect.observation, EFFECT_OBSERVATIONS.MODIFIED);
    assert.equal(metadata.effectVerification, 'observed');
  } finally {
    cleanup();
  }
});

// ─── outcome binds to the admission it cites (#1866) ─────────────────────────

function admitFileAction(dir, name, extra = {}) {
  const file = path.join(dir, name);
  const envelope = {
    invocationId: `effect-bind-${Math.random().toString(36).slice(2)}`,
    agentName: 'test-agent',
    sessionId: 'session',
    toolName: 'Write',
    args: { file_path: file },
    cwd: dir,
    workspaceRoot: dir,
    ...extra,
  };
  const writer = { append() {} };
  const admission = evaluateExternalAction(envelope, { receiptWriter: writer });
  const outcomeFor = (override = {}) => recordExternalActionOutcome(
    { ...envelope, ...override }, admission.receipt, { status: 'success' }, { receiptWriter: writer },
  ).receipt.metadata;
  return { file, envelope, admission: admission.receipt, outcomeFor };
}

test('an outcome citing another invocation and target stays reported', () => {
  // The issue repro: fileBefore measured A, the outcome envelope names B, and
  // the pair must never become an `observed` verdict about either file.
  const { dir, cleanup } = workspace();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'original');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'different');
    const ctx = admitFileAction(dir, 'a.txt');
    const metadata = ctx.outcomeFor({
      invocationId: 'different-action',
      args: { file_path: path.join(dir, 'b.txt') },
    });
    assert.equal(metadata.fileEffect, null);
    assert.equal(metadata.effectVerification, 'reported');
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8'), 'original');
  } finally {
    cleanup();
  }
});

test('the same invocation naming a different target stays reported', () => {
  const { dir, cleanup } = workspace();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'v1');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'v1');
    const ctx = admitFileAction(dir, 'a.txt');
    const metadata = ctx.outcomeFor({ args: { file_path: path.join(dir, 'b.txt') } });
    assert.equal(metadata.fileEffect, null);
    assert.equal(metadata.effectVerification, 'reported');
  } finally {
    cleanup();
  }
});

test('the same target under a different invocation stays reported', () => {
  const { dir, cleanup } = workspace();
  try {
    const ctx = admitFileAction(dir, 'a.txt');
    fs.writeFileSync(ctx.file, 'v1');
    const metadata = ctx.outcomeFor({ invocationId: 'different-action' });
    assert.equal(metadata.fileEffect, null);
    assert.equal(metadata.effectVerification, 'reported');
  } finally {
    cleanup();
  }
});

test('the same action in a different workspace stays reported', () => {
  const { dir, cleanup } = workspace();
  try {
    const ctx = admitFileAction(dir, 'a.txt');
    fs.writeFileSync(ctx.file, 'v1');
    const metadata = ctx.outcomeFor({ workspaceId: 'other' });
    assert.equal(metadata.fileEffect, null);
    assert.equal(metadata.effectVerification, 'reported');
  } finally {
    cleanup();
  }
});

test('a bound outcome still observes a real change', () => {
  // Binding must not cost the honest case: same invocation, workspace and
  // target with a file that actually changed stays observed/modified.
  const { dir, cleanup } = workspace();
  try {
    const ctx = admitFileAction(dir, 'a.txt');
    fs.writeFileSync(ctx.file, 'v2');
    const metadata = ctx.outcomeFor();
    assert.equal(metadata.fileEffect.observation, EFFECT_OBSERVATIONS.CREATED);
    assert.equal(metadata.effectVerification, 'observed');
  } finally {
    cleanup();
  }
});

test('a malformed first reading measures nothing', () => {
  const { dir, cleanup } = workspace();
  try {
    const ctx = admitFileAction(dir, 'a.txt');
    fs.writeFileSync(ctx.file, 'v1');
    const tampered = {
      ...ctx.admission,
      metadata: { ...ctx.admission.metadata, fileBefore: 'digested' },
    };
    const writer = { append() {} };
    const metadata = recordExternalActionOutcome(ctx.envelope, tampered,
      { status: 'success' }, { receiptWriter: writer }).receipt.metadata;
    assert.equal(metadata.fileEffect, null);
    assert.equal(metadata.effectVerification, 'reported');
  } finally {
    cleanup();
  }
});
