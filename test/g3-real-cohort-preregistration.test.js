'use strict';

/**
 * G3 real-cohort preregistration pin (#4423).
 *
 * The other G3 measurements drive synthetic grammar fixtures. This one pins the
 * *real* task source the plan §G3 corpus clause asks for: a verified failure
 * record produced by the error-prevention engine, projected onto a coder task by
 * the task producer. The chain is exercised for real -- real engine, real
 * record, real producer -- and the preregistration document that freezes the
 * protocol must exist and keep its frozen sections.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MemoryStore = require('../lib/memory-store');
const { createErrorPrevention } = require('../lib/error-prevention');
const { PRODUCER_STATUSES, produceTask } = require('../lib/task-producer');

const PREREGISTRATION = path.join(__dirname, '..', 'docs', 'task-packs',
  'g3-real-cohort-preregistration-20261030.md');

/** A verified failure record, produced by the real engine (no hand-built record). */
function verifiedFailure(overrides = {}) {
  const memory = new MemoryStore({ useSQLite: false });
  const prevention = createErrorPrevention(memory, {
    verifyEvidence: ({ source, evidence }) => source === 'test_failure'
      && evidence.some(item => item?.type === 'test' && item?.verifiedBy === 'ci'),
  });
  const recorded = prevention.recordFailure({
    tool: 'coder', operation: 'replace_text', path: 'src/version.js', workspaceId: 'default',
    source: 'test_failure', observed: 'v1.0.0', expected: 'v1.1.0',
    evidence: [{ type: 'test', verifiedBy: 'ci' }], ...overrides,
  });
  assert.equal(recorded.ok, true);
  return recorded.failure;
}

describe('G3 real-cohort preregistration (#4423)', () => {
  it('keeps the preregistration document with its frozen sections', () => {
    const text = fs.readFileSync(PREREGISTRATION, 'utf8');
    for (const heading of ['## 2. Gerçek görev kaynağı', '## 4. Külliyat',
      '## 5. Bölme ve sızıntı', '## 7. Ön-kayıtlı eşikler', '## 8. Karar kuralları']) {
      assert.ok(text.includes(heading), `missing frozen section: ${heading}`);
    }
    assert.match(text, /ErrorPrevention\.recordFailure\(\)/);
    assert.match(text, /Clopper.Pearson/);
    assert.match(text, /assertsGain` her durumda `false/);
  });

  it('projects a verified failure record from the real engine onto a task', () => {
    const failure = verifiedFailure();
    assert.equal(failure.verificationStatus, 'verified');
    const produced = produceTask(failure);
    assert.equal(produced.status, PRODUCER_STATUSES.TASK_PRODUCED);
    assert.equal(produced.task.operation.type, 'replace_text');
    assert.equal(produced.task.operation.find, 'v1.0.0');
    assert.equal(produced.task.operation.replace, 'v1.1.0');
    assert.deepEqual(produced.task.allowedPaths, ['src/version.js']);
  });

  it('refuses an unverified record instead of inventing a task', () => {
    const memory = new MemoryStore({ useSQLite: false });
    // Evidence that does not verify: the engine stores the record as unverified.
    const prevention = createErrorPrevention(memory, { verifyEvidence: () => false });
    const recorded = prevention.recordFailure({
      tool: 'coder', operation: 'replace_text', path: 'src/version.js', workspaceId: 'default',
      source: 'test_failure', observed: 'v1.0.0', expected: 'v1.1.0',
      evidence: [{ type: 'test', verifiedBy: 'ci' }],
    });
    assert.equal(recorded.ok, true);
    assert.notEqual(recorded.failure.verificationStatus, 'verified');
    assert.equal(produceTask(recorded.failure).task, null);
  });

  it('refuses a supported operation the record does not satisfy', () => {
    // A declared `json_schema_route_test` is outside the producer's transform
    // set, so the chain yields no task rather than a guessed one.
    const failure = verifiedFailure({ operation: 'json_schema_route_test' });
    assert.equal(produceTask(failure).task, null);
  });
});
