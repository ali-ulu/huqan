'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const facade = require('../lib/background-provenance');
const projection = require('../lib/background-provenance-projection');

test('background provenance facade preserves the extracted projection contract', () => {
  for (const key of [
    'UNCLASSIFIED_SOURCE_CONFIDENCE',
    'TRUST_POLICY_UNAVAILABLE_CONFIDENCE',
    'admissionRiskFromConfidence',
    'buildBackgroundProvenance',
    'sponsorBackgroundProvenance',
    'provenanceFieldsFrom',
  ]) {
    assert.equal(facade[key], projection[key], key);
  }

  assert.equal(projection.admissionRiskFromConfidence(0.5), 0);
  assert.equal(projection.admissionRiskFromConfidence(0.4), 60);
  assert.equal(projection.admissionRiskFromConfidence(0.1), 90);

  assert.deepEqual(
    projection.provenanceFieldsFrom({
      sourceType: 'github',
      sourceRef: 'repo:owner/name',
      actor: 'plugin:test',
      sourceVersion: 'abc123',
      contentHash: 'deadbeef',
    }),
    {
      sourceType: 'github',
      sourceRef: 'repo:owner/name',
      actor: 'plugin:test',
      sourceVersion: 'abc123',
      contentHash: 'deadbeef',
    },
  );
});
