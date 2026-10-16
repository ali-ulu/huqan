'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  buildProvenance,
  legacyProvenanceId,
  isLegacyProvenanceId,
} = require('../lib/provenance-ingest');

test('#2610: the provenance id mint is sha256/128-bit', () => {
  const { provenance } = buildProvenance({
    sourceRef: 'mcp.huqan.learn.appr_1',
    timestamp: '2026-09-01T00:02:07.203Z',
  });
  assert.match(provenance.provenanceId, /^prov_[0-9a-f]{32}$/);

  // Same base -> same id; different base -> different id.
  const again = buildProvenance({
    sourceRef: 'mcp.huqan.learn.appr_1',
    timestamp: '2026-09-01T00:02:07.203Z',
  });
  assert.equal(again.provenance.provenanceId, provenance.provenanceId);

  const other = buildProvenance({
    sourceRef: 'mcp.huqan.learn.appr_2',
    timestamp: '2026-09-01T00:02:07.203Z',
  });
  assert.notEqual(other.provenance.provenanceId, provenance.provenanceId);
});

test('#2610: the sha256 mint is NOT the legacy sha1 id', () => {
  const input = {
    sourceRef: 'mcp.huqan.learn.appr_1',
    timestamp: '2026-09-01T00:02:07.203Z',
  };
  const legacy = legacyProvenanceId(input);
  assert.match(legacy, /^prov_[0-9a-f]{16}$/);
  const fresh = buildProvenance(input).provenance.provenanceId;
  assert.notEqual(fresh, legacy);
  // 128-bit entropy: the new id is exactly the sha256 prefix, not a sha1 one.
  const expected = 'prov_' + crypto
    .createHash('sha256')
    .update('mcp.huqan.learn.appr_1|||2026-09-01T00:02:07.203Z', 'utf8')
    .digest('hex')
    .slice(0, 32);
  assert.equal(fresh, expected);
});

test('#2610: legacy mint reproduces the pre-migration id byte-for-byte', () => {
  // This literal was produced by the pre-#2610 mint and observed in the
  // runtime store (tool_approvals.context_json).
  const legacy = legacyProvenanceId({
    sourceRef: 'mcp.huqan.learn.approval-4b55fb42-0436-4bd4-a2cf-f1785ed937af',
    timestamp: '2026-09-01T00:02:07.203Z',
  });
  assert.equal(legacy, 'prov_f888e9f239ad54f4');
});

test('#2610: legacy-id detection is exact', () => {
  assert.ok(isLegacyProvenanceId('prov_f888e9f239ad54f4'));
  assert.ok(!isLegacyProvenanceId('prov_f888e9f239ad54f4ff')); // 32-hex = new mint
  assert.ok(!isLegacyProvenanceId('prov_F888E9F239AD54F4')); // uppercase rejected
  assert.ok(!isLegacyProvenanceId('external:agent:session'));
  assert.ok(!isLegacyProvenanceId(undefined));
});

test('#2610: caller-supplied provenanceId passes through untouched', () => {
  const { provenance } = buildProvenance({ provenanceId: 'prov-my-custom-id' });
  assert.equal(provenance.provenanceId, 'prov-my-custom-id');
});
