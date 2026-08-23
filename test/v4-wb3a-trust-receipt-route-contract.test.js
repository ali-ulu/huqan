'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const {
  ROUTE_PREFIX,
  parseWorkbenchTrustReceiptPath,
  handleWorkbenchTrustReceiptRequest,
} = require('../lib/workbench/trust-receipt-route');

describe('V4-WB3A: workbench trust receipt route contract (pure, no server)', () => {
  describe('parseWorkbenchTrustReceiptPath', () => {
    it('extracts a valid receiptId', () => {
      const result = parseWorkbenchTrustReceiptPath(`${ROUTE_PREFIX}receipt-123`);
      assert.deepEqual(result, { ok: true, receiptId: 'receipt-123' });
    });

    it('decodes a URL-encoded receiptId', () => {
      const result = parseWorkbenchTrustReceiptPath(`${ROUTE_PREFIX}${encodeURIComponent('receipt id/x')}`);
      assert.equal(result.ok, true);
      assert.equal(result.receiptId, 'receipt id/x');
    });

    it('returns null for a non-matching path', () => {
      assert.equal(parseWorkbenchTrustReceiptPath('/api/trust-receipt/x'), null);
      assert.equal(parseWorkbenchTrustReceiptPath('/api/workbench/memory-context/x'), null);
    });

    it('returns missing_receipt_id for an empty segment', () => {
      const result = parseWorkbenchTrustReceiptPath(ROUTE_PREFIX);
      assert.deepEqual(result, { ok: false, code: 'missing_receipt_id', receiptId: '' });
    });

    it('returns invalid_receipt_id for malformed percent-encoding', () => {
      const result = parseWorkbenchTrustReceiptPath(`${ROUTE_PREFIX}%E0%A4%A`);
      assert.deepEqual(result, { ok: false, code: 'invalid_receipt_id', receiptId: '' });
    });

    it('returns invalid_receipt_id for a whitespace-only segment', () => {
      const result = parseWorkbenchTrustReceiptPath(`${ROUTE_PREFIX}${encodeURIComponent('   ')}`);
      assert.deepEqual(result, { ok: false, code: 'invalid_receipt_id', receiptId: '' });
    });

    it('clamps an oversized receiptId rather than rejecting outright', () => {
      const long = 'a'.repeat(500);
      const result = parseWorkbenchTrustReceiptPath(`${ROUTE_PREFIX}${long}`);
      assert.equal(result.ok, true);
      assert.equal(result.receiptId.length, 128);
    });

    it('strips embedded tab/CR/LF instead of letting them survive into receiptId (#1301)', () => {
      const result = parseWorkbenchTrustReceiptPath(
        `${ROUTE_PREFIX}${encodeURIComponent('r-1\t\r\n[FORGED] admin escalated')}`
      );
      assert.equal(result.ok, true);
      assert.equal(result.receiptId, 'r-1[FORGED] admin escalated');
      assert.equal(/[\x00-\x1F\x7F]/.test(result.receiptId), false);
    });
  });

  describe('handleWorkbenchTrustReceiptRequest status mapping', () => {
    it('maps a found receipt to 200 with the inspector body verbatim', () => {
      const receipt = Object.freeze({
        receiptId: 'r-1',
        workspaceId: 'default',
        metadata: { action: 'learn' },
      });
      const readReceipt = (source, receiptId, filters) => ({
        ok: true,
        receiptId,
        receipt,
        canonicalPayload: { verdict: 'allow', reason: 'ok' },
        chainedReceipt: null,
        auditEvent: {},
        chainStatus: 'valid',
      });

      const { statusCode, body } = handleWorkbenchTrustReceiptRequest({
        receiptId: 'r-1',
        workspaceId: 'default',
        source: {},
        readReceipt,
      });

      assert.equal(statusCode, 200);
      assert.equal(body.ok, true);
      assert.equal(body.status, 'found');
      assert.equal(body.receiptId, 'r-1');
      assert.equal(body.verdict, 'allow');
    });

    it('maps not_found to 404', () => {
      const readReceipt = () => ({ ok: false, status: 'not_found' });
      const { statusCode, body } = handleWorkbenchTrustReceiptRequest({
        receiptId: 'missing',
        source: {},
        readReceipt,
      });
      assert.equal(statusCode, 404);
      assert.equal(body.ok, false);
      assert.equal(body.status, 'not_found');
    });

    it('sanitizes receiptId even when called directly with unsanitized input (#1301)', () => {
      let seenReceiptId = null;
      const readReceipt = (source, receiptId) => {
        seenReceiptId = receiptId;
        return { ok: false, status: 'not_found' };
      };
      handleWorkbenchTrustReceiptRequest({
        receiptId: 'r-1\r\ninjected log line',
        source: {},
        readReceipt,
      });
      assert.equal(seenReceiptId, 'r-1injected log line');
    });

    it('maps a missing receiptId to invalid_request / 400', () => {
      const { statusCode, body } = handleWorkbenchTrustReceiptRequest({
        receiptId: '',
        source: {},
      });
      assert.equal(statusCode, 400);
      assert.equal(body.status, 'invalid_request');
    });

    it('maps a missing source to read_error / 502', () => {
      const { statusCode, body } = handleWorkbenchTrustReceiptRequest({
        receiptId: 'r-1',
        source: undefined,
      });
      assert.equal(statusCode, 502);
      assert.equal(body.status, 'read_error');
    });

    it('maps a throwing read source to read_error / 502 without throwing', () => {
      const readReceipt = () => {
        throw new Error('boom');
      };
      assert.doesNotThrow(() => {
        const { statusCode, body } = handleWorkbenchTrustReceiptRequest({
          receiptId: 'r-1',
          source: {},
          readReceipt,
        });
        assert.equal(statusCode, 502);
        assert.equal(body.status, 'read_error');
      });
    });

    it('trims and bounds workspaceId before delegating', () => {
      let seenFilters;
      const readReceipt = (source, receiptId, filters) => {
        seenFilters = filters;
        return { ok: false, status: 'not_found' };
      };
      handleWorkbenchTrustReceiptRequest({
        receiptId: 'r-1',
        workspaceId: '  ws-1  ',
        source: {},
        readReceipt,
      });
      assert.equal(seenFilters.workspaceId, 'ws-1');
    });

    it('never mutates the object passed as options', () => {
      const options = Object.freeze({
        receiptId: 'r-1',
        workspaceId: 'ws-1',
        source: {},
        readReceipt: () => ({ ok: false, status: 'not_found' }),
      });
      assert.doesNotThrow(() => handleWorkbenchTrustReceiptRequest(options));
    });
  });
});
