'use strict';

/**
 * The Evidence panel must not report success over an empty projection, and must
 * hand a receipt id to the lookup that can resolve one.
 *
 * Both halves came from one operator report. A workflow returned an approval
 * receipt id, the panel filled itself in with that id in `targetId` mode, and
 * `/api/trust-receipt?targetId=...` answered `ok:true` with a freshly generated
 * shell -- status `unknown`, confidence 0, every field blank -- over which the
 * panel printed "Receipt found." The id was never resolvable that way: the
 * targetId projection looks for nodes, edges, candidate claims and provenance
 * records, never receipts.
 *
 * That is #766 reappearing through a different door. There the fix went into
 * readReceiptById, which refuses to call a broken chain "found"; the query path
 * kept saying it. And because the query path always answers `ok:true`, the
 * panel could not report a miss at all -- the honest reading was structurally
 * unavailable, whatever the store held.
 *
 * These are source assertions rather than DOM ones because the behaviour lives
 * in one minified bundle with no module seam to import. They pin strings, not
 * line numbers, so moving the code does not break them.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { describe, it } = require('node:test');

const APP_JS = path.join(__dirname, '..', 'public', 'js', 'app.js');
const LOCALES = path.join(__dirname, '..', 'public', 'locales');

function appSource() {
  return fs.readFileSync(APP_JS, 'utf8');
}

/** The predicate itself, lifted out of the bundle so it can be exercised. */
function loadNoEvidence() {
  const match = appSource().match(/function noEvidence\(detail,x\)\{.*?\}\r?\n/s);
  assert.ok(match, 'app.js must define the noEvidence predicate');
  // eslint-disable-next-line no-new-func
  return new Function(`${match[0]}; return noEvidence;`)();
}

describe('Evidence lookup honesty', () => {
  it('hands a receipt id to the receiptId lookup, never to targetId', () => {
    const source = appSource();
    assert.ok(
      source.includes("$('emode').value=d.receiptId?'receiptId':'sourceRef'"),
      'a workflow receipt id must select receiptId mode; targetId cannot resolve one',
    );
    assert.equal(
      source.includes("$('emode').value=d.receiptId?'targetId':'sourceRef'"),
      false,
      'the targetId handoff is the defect and must not come back',
    );
  });

  it('does not report success over an empty projection', () => {
    const source = appSource();
    assert.ok(source.includes('noEvidence(detail,data)'), 'the status label must consult the projection');
    assert.equal(
      /estatus\(T\('evidence\.found'[^)]*\),0,true\)/.test(source),
      false,
      'the success label must not be reachable unconditionally',
    );
  });

  const emptyProjection = Object.freeze({
    status: 'unknown',
    provenance: null,
    candidateClaim: null,
    canonical: false,
    auditTrail: [],
    confidence: 0,
  });

  it('calls the empty shell what it is', () => {
    assert.equal(loadNoEvidence()(false, emptyProjection), true);
  });

  it('leaves a real receipt alone', () => {
    const noEvidence = loadNoEvidence();
    assert.equal(noEvidence(false, {
      ...emptyProjection, status: 'canonical', canonical: true, provenance: {}, auditTrail: [{}],
    }), false);
    // Any one signal of evidence is enough; `unknown` alone is not the trigger.
    assert.equal(noEvidence(false, { ...emptyProjection, auditTrail: [{}] }), false);
    assert.equal(noEvidence(false, { ...emptyProjection, provenance: {} }), false);
    assert.equal(noEvidence(false, { ...emptyProjection, candidateClaim: {} }), false);
  });

  it('never second-guesses the receipt-detail route', () => {
    // That route reports its own failures (not_found, chain_invalid) and its
    // payload is a receipt rather than a projection, so the shell test does not
    // apply to it.
    assert.equal(loadNoEvidence()(true, emptyProjection), false);
  });

  it('carries the message in every catalogue', () => {
    for (const file of ['en.json', 'tr.json']) {
      const catalogue = JSON.parse(fs.readFileSync(path.join(LOCALES, file), 'utf8'));
      const message = catalogue.evidence?.noEvidence;
      assert.equal(typeof message, 'string', `${file} must define evidence.noEvidence`);
      assert.ok(message.trim().length > 0, `${file}: evidence.noEvidence must not be empty`);
      assert.ok(
        message.includes('receiptId'),
        `${file}: the message must name the mode that can resolve a receipt id`,
      );
    }
  });
});
