'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

// #2200 (#2123): lib/huqan-package-format.js picked each embedded collection's
// id field through a switch that repeated the collection list already held in
// OBJECT_TYPE_MAP. Collections, their ATP type and their id field now live in
// one table. The first block pins today's behaviour through the public
// validator and must be green before and after the change.

const { validateAxiomPackage } = require('../lib/huqan-package-format');
const { ATP_OBJECT_TYPES } = require('../lib/atp-conformance');

const FIXTURE = path.join(__dirname, '..', 'specs', 'axiom-package-format', '0.1', 'examples', 'package.trust-receipt-bundle.axiom.json');
const COLLECTIONS = {
  provenanceRecords: ['provenanceRecord', 'provenanceId'],
  auditEvents: ['auditEvent', 'auditId'],
  candidateClaims: ['candidateClaim', 'candidateId'],
  conflictResults: ['conflictResult', 'conflictId'],
  verificationResults: ['verificationResult', 'verificationId'],
  trustReceipts: ['trustReceipt', 'receiptId'],
  causalChains: ['causalChain', 'chainId'],
  simulationResults: ['simulationResult', 'simulationId'],
};

describe('embedded object ids are read from each collection id field (unchanged)', () => {
  for (const [collection, [typeKey, idField]] of Object.entries(COLLECTIONS)) {
    it(`${collection} objects are matched by ${idField}`, () => {
      const pkg = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
      const id = `probe-2200-${collection}`;
      const ownType = ATP_OBJECT_TYPES[typeKey];
      const otherType = Object.values(ATP_OBJECT_TYPES).find((type) => type !== ownType);
      pkg.objects = pkg.objects || {};
      pkg.objects[collection] = [...(Array.isArray(pkg.objects[collection]) ? pkg.objects[collection] : []), { [idField]: id, workspaceId: 'ws-2200' }];
      pkg.index.byId[id] = { type: otherType, workspaceId: 'ws-2200' };

      const result = validateAxiomPackage(pkg);
      const mismatch = result.errors.find((err) => String(err.field) === `index.byId.${id}.type`
        && /must match embedded object type/.test(String(err.message)));
      assert.ok(mismatch, `the embedded ${collection} object was not found by ${idField}: ${JSON.stringify(result.errors.filter((err) => String(err.field).includes(id)))}`);
      assert.match(String(mismatch.message), new RegExp(ownType));
    });
  }
});

describe('collections are one registry (#2200)', () => {
  it('lib/huqan-package-format.js no longer switches on the collection name', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'lib', 'huqan-package-format.js'), 'utf8');
    assert.doesNotMatch(source, /switch\s*\(\s*collectionName\s*\)/);
  });

  it('the architecture snapshot no longer sees a growing dispatch here', () => {
    const row = require('../scripts/architecture-snapshot').snapshot().find((item) => item.file === 'lib/huqan-package-format.js');
    assert.ok(row, 'the file is measured');
    assert.ok(!row.signals.some((signal) => signal.startsWith('OCP')), JSON.stringify(row.signals));
  });
});
