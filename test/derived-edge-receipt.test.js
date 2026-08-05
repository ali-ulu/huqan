'use strict';

/**
 * Closes issue #214: derived `benzer` edges written via the parent-allowed
 * _crossLink path inherited the parent write's decision but produced no
 * receipt of their own. Since the derived write happens under the SAME
 * admission decision as the parent (see kernel.js _crossLink comment), the
 * fix reuses that decision's existing receipt rather than minting a new one
 * — kernel._admissionReceiptDetails() is the same helper already used for
 * the parent edge's own audit event (lib/learn-use-case.js).
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Kernel = require('../kernel');

function makeKernel() {
  return new Kernel({ noLoad: true, useSQLite: false, loadPlugins: false });
}

describe('derived_edge audit carries parent admission receipt', () => {
  it('attaches receiptId/receipt to the derived_edge audit when parent admission allowed the write', () => {
    const kernel = makeKernel();
    kernel.graph.addNode('kedi', null, 'default');
    kernel.graph.addNode('kopek', null, 'default');
    kernel.graph.addTag('kedi', 'tag-shared', 0.9, 'default');
    kernel.graph.addTag('kopek', 'tag-shared', 0.9, 'default');
    kernel.graph.addNode('tag-shared', null, 'default');

    const parentAdmission = {
      receiptId: 'madm_receipt_test123',
      receipt: { receiptId: 'madm_receipt_test123', receiptKind: 'memory_admission_receipt', decision: 'allow' },
    };

    const result = kernel._crossLink('kedi', 'kopek', 'benzer', 'default', {
      parentAdmissionAllowed: true,
      parentAdmission,
      derivedSource: 'learn',
    });

    assert.equal(result.written, 1);

    const events = kernel.graph.getAuditEvents({ workspaceId: 'default' });
    const derived = events.filter((ev) => ev.targetType === 'derived_edge');
    assert.equal(derived.length, 1);
    assert.equal(derived[0].details.receiptId, 'madm_receipt_test123');
    assert.deepEqual(derived[0].details.receipt, parentAdmission.receipt);
  });

  it('does not attach a receipt when no parent admission is provided (background path unchanged)', () => {
    const kernel = makeKernel();
    kernel.graph.addNode('kedi', null, 'default');
    kernel.graph.addNode('kopek', null, 'default');
    kernel.graph.addTag('kedi', 'tag-shared', 0.9, 'default');
    kernel.graph.addTag('kopek', 'tag-shared', 0.9, 'default');
    kernel.graph.addNode('tag-shared', null, 'default');

    const result = kernel._crossLink('kedi', 'kopek', 'benzer', 'default', {
      parentAdmissionAllowed: true,
      derivedSource: 'learn',
    });

    assert.equal(result.written, 1);
    const events = kernel.graph.getAuditEvents({ workspaceId: 'default' });
    const derived = events.filter((ev) => ev.targetType === 'derived_edge');
    assert.equal(derived.length, 1);
    assert.equal(derived[0].details.receiptId, undefined);
  });
});
