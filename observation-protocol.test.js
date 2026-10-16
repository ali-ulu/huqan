'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SPEC_DIR = path.join(__dirname, 'specs', 'huqan-observation-protocol', '0.1');
const REQUIRED = [
  'schemaVersion',
  'agent_id',
  'run_id',
  'step_id',
  'action',
  'target',
  'input_hash',
  'observed_state',
  'decision',
  'receipt_id',
];
const DECISIONS = new Set(['unknown', 'allow', 'review', 'block', 'dry_run_only']);

function validateEnvelope(event) {
  for (const key of REQUIRED) {
    assert.ok(Object.prototype.hasOwnProperty.call(event, key), `missing ${key}`);
  }
  assert.strictEqual(event.schemaVersion, 'huqan.external-event.v1');
  assert.match(event.input_hash, /^[0-9a-f]{64}$/);
  assert.ok(DECISIONS.has(event.decision), `bad decision ${event.decision}`);
  assert.ok(typeof event.action === 'string' && event.action.length > 0);
  assert.ok(event.receipt_id === null || typeof event.receipt_id === 'string');
  const extra = Object.keys(event).filter((k) => !REQUIRED.includes(k));
  assert.deepStrictEqual(extra, [], `unexpected keys ${extra.join(',')}`);
}

describe('observation-protocol 0.1 examples', () => {
  it('all shipped examples validate against the envelope', () => {
    const examplesDir = path.join(SPEC_DIR, 'examples');
    const files = fs.readdirSync(examplesDir).filter((f) => f.endsWith('.json')).sort();
    assert.ok(files.length >= 3, 'expected at least 3 examples');
    for (const file of files) {
      const event = JSON.parse(fs.readFileSync(path.join(examplesDir, file), 'utf8'));
      validateEnvelope(event);
    }
  });

  it('schema file declares the same required fields', () => {
    const schema = JSON.parse(
      fs.readFileSync(path.join(SPEC_DIR, 'schemas', 'external-event.schema.json'), 'utf8')
    );
    assert.deepStrictEqual([...schema.required].sort(), [...REQUIRED].sort());
  });
});
