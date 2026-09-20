'use strict';

/**
 * T1 property: receipt chain integrity (#2634).
 *
 * Every receipt links to a valid parent; any tampering with content or
 * linkage is detected by validateReceiptChain with an exact break index.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const { buildCanonicalReceiptPayload } = require('../../lib/receipt/canonical-receipt');
const {
  appendReceiptToChain,
  validateReceiptChain,
} = require('../../lib/receipt/receipt-chain');
const { CANONICAL_VERDICTS } = require('../../lib/verdict/action-verdict');

const NUM_RUNS = 1000;

const tokenArb = fc.stringMatching(/^[A-Za-z0-9][A-Za-z0-9_-]{1,24}$/);
const verdictArb = fc.constantFrom(...CANONICAL_VERDICTS);

function makePayload(t, verdict) {
  return buildCanonicalReceiptPayload(
    {
      receiptId: `r-${t}`,
      receiptKind: 'memory-admission',
      decision: 'admit',
      status: 'admitted',
      admissionId: `adm-${t}`,
      workspaceId: `ws-${t}`,
      provenanceId: `prov-${t}`,
      trustPolicyVersion: '1.0.0',
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) + (Number(t.slice(-6).replace(/\D/g, '') || 0) % 86400000)).toISOString(),
    },
    { verdict },
  );
}

describe('property: receipt chain integrity', () => {
  it('untampered chains always validate', () => {
    fc.assert(
      fc.property(
        fc.array(tokenArb, { minLength: 1, maxLength: 8 }),
        verdictArb,
        (tokens, verdict) => {
          let prev = null;
          const chain = tokens.map((t) => {
            const rec = appendReceiptToChain(makePayload(t, verdict), prev);
            prev = rec.receiptHash;
            return rec;
          });
          const result = validateReceiptChain(chain);
          assert.equal(result.valid, true, 'untampered chain must validate');
          assert.equal(result.brokenAt, null);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('any content tamper is detected at the exact index', () => {
    fc.assert(
      fc.property(
        fc.array(tokenArb, { minLength: 2, maxLength: 6 }),
        verdictArb,
        fc.constantFrom('content', 'link'),
        (tokens, verdict, tamperKind) => {
          let prev = null;
          const chain = tokens.map((t) => {
            const rec = appendReceiptToChain(makePayload(t, verdict), prev);
            prev = rec.receiptHash;
            return rec;
          });
          const victim = Math.floor(tokens.length / 2);
          const tampered = chain.map((rec, i) => {
            if (i !== victim) return rec;
            if (tamperKind === 'content') {
              return { ...rec, workspaceId: `${rec.workspaceId}-tampered` };
            }
            return { ...rec, previousReceiptHash: 'tampered-link' };
          });
          const result = validateReceiptChain(tampered);
          assert.equal(result.valid, false, 'tampered chain must not validate');
          assert.equal(result.brokenAt, victim, 'break index must be exact');
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });
});
