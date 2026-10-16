'use strict';

/**
 * With strictProvenance on, `learn` must refuse a write that names no source --
 * and the predicate the explicit gate uses must be about provenance.
 *
 * The gate tested `hasProvenanceInput`, which answers a much broader question
 * ("is there anything here worth normalizing?") and says yes for `workspaceId`,
 * `actor` and `timestamp`. Those are routine call parameters, not provenance.
 *
 * The refusal itself was never bypassable: `_normalizeProvenanceInput` runs
 * first under strictProvenance and rejects an incomplete record, so a caller
 * passing only `workspaceId` was already refused. These tests pin that
 * behaviour so the redundancy stays a redundancy -- if the normalizer's
 * strictness is ever relaxed, the gate behind it now asks the right question.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const Kernel = require('../kernel');
const { hasRealProvenance } = require('../lib/learn-use-case');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-strict-prov-'));

let counter = 0;
function strictKernel() {
  counter += 1;
  return new Kernel({
    noLoad: true,
    useSQLite: false,
    strictProvenance: true,
    memoryPath: path.join(tempDir, `strict-${counter}.json`),
    dbPath: path.join(tempDir, `strict-${counter}.db`),
  });
}

const COMPLETE_PROVENANCE = {
  provenanceId: 'prov-1',
  sourceRef: 'docs/claims.md#1',
  sourceTitle: 'Claims',
  sourceType: 'document',
  actor: 'ali',
  timestamp: '2026-08-24T00:00:00.000Z',
  confidence: 0.9,
  workspaceId: 'workspace-a',
  trustPolicyVersion: '1.0.0',
};

test('routine call parameters are not provenance', () => {
  for (const opts of [
    {},
    { workspaceId: 'workspace-a' },
    { actor: 'ali' },
    { timestamp: '2026-08-24T00:00:00.000Z' },
    { sourceTitle: 'Some title' },
    { workspaceId: 'workspace-a', actor: 'ali', timestamp: '2026-08-24T00:00:00.000Z' },
    { provenance: {} },
    { provenance: { sourceRef: '   ' } },
    { provenance: null },
    { provenance: ['docs/claims.md#1'] },
  ]) {
    assert.equal(hasRealProvenance(opts), false, `${JSON.stringify(opts)} names no source`);
  }
});

test('a named source counts as provenance', () => {
  for (const opts of [
    { sourceRef: 'docs/claims.md#1' },
    { sourceType: 'document' },
    { provenance: COMPLETE_PROVENANCE },
    { provenance: { provenanceId: 'prov-1' } },
  ]) {
    assert.equal(hasRealProvenance(opts), true, `${JSON.stringify(opts)} names a source`);
  }
});

test('strictProvenance refuses a learn that names no source', () => {
  for (const opts of [
    { workspaceId: 'workspace-a' },
    { actor: 'ali' },
    { sourceTitle: 'Some title' },
    { provenance: {} },
  ]) {
    assert.throws(
      () => strictKernel().learn('kedi hayvandir', opts),
      /provenance is required/i,
      `${JSON.stringify(opts)} must be refused`,
    );
  }
});

test('a refused learn writes nothing and is audited', () => {
  const kernel = strictKernel();

  assert.throws(() => kernel.learn('kedi hayvandir', { workspaceId: 'workspace-a' }), /provenance is required/i);

  assert.equal(kernel.graph.getEdges('kedi', 'workspace-a').length, 0);
  const rejects = kernel.graph.getAuditEvents({ eventType: 'REJECT', workspaceId: 'workspace-a' });
  assert.ok(
    rejects.some((event) => event.details?.reason === 'PROVENANCE_REQUIRED'),
    'the refusal must leave an audit record',
  );
});

test('a complete provenance record still passes the gate', () => {
  assert.doesNotThrow(() => strictKernel().learn('kedi hayvandir', { provenance: COMPLETE_PROVENANCE }));
});

test('strictProvenance off still learns without a source', () => {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    memoryPath: path.join(tempDir, 'lax.json'),
    dbPath: path.join(tempDir, 'lax.db'),
  });

  assert.doesNotThrow(() => kernel.learn('kedi hayvandir', { workspaceId: 'workspace-a' }));
});
