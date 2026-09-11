'use strict';

/**
 * Read one Trust Receipt by its own id, over MCP.
 *
 * Every MCP tool response carries a `receiptId`, and until this tool existed
 * nothing over MCP could open it. `huqan.trust_receipt` searches by what the
 * receipt is *about* -- targetId, provenanceId, sourceRef, candidateId,
 * eventType -- and takes no receiptId at all; reading one by id lived only on
 * `GET /api/v2/trust-receipts/{id}`. An operator working through an MCP client
 * was handed an identifier for a document they could not open without changing
 * tools.
 *
 * The verdict is forwarded exactly as readReceiptById states it. A receipt
 * whose chain does not validate comes back `ok:false` on purpose (#766): the
 * payload is still useful for working out what broke, but calling it found
 * would present a broken transcript as canonical -- which is what the viewer
 * once did.
 */

const { readReceiptById } = require('../receipt/receipt-read-index');
const { sanitizeMcpString } = require('../mcp-input-sanitizers');
const { withMcpToolVerdictSurface } = require('./response-builders');

function invalidInput(message) {
  return {
    ok: false,
    type: 'trust_receipt_detail',
    data: null,
    evidence: [],
    error: { code: 'INVALID_INPUT', message },
    meta: {},
  };
}

function executeMcpTrustReceiptDetail({ kernel, name, args, gate }) {
  const workspaceId = sanitizeMcpString(args.workspaceId, 128);
  const receiptId = sanitizeMcpString(args.receiptId, 256);

  if (!workspaceId || !receiptId) {
    return withMcpToolVerdictSurface(
      invalidInput('workspaceId and receiptId are both required.'),
      name, args, gate,
    );
  }

  // Workspace-scoped, like every other receipt read: an id from another
  // workspace must not resolve just because the caller knows it.
  const read = readReceiptById(kernel.graph, receiptId, { workspaceId });

  if (!read || read.ok !== true) {
    return withMcpToolVerdictSurface({
      ok: false,
      type: 'trust_receipt_detail',
      data: null,
      evidence: [],
      // `status` is the read index's own word for what went wrong -- not_found,
      // chain_invalid, and so on. Keeping it beside the code means the caller
      // can tell "no such receipt" from "this receipt does not hold up".
      error: {
        code: read?.error?.code || 'RECEIPT_NOT_FOUND',
        message: read?.error?.message || 'The receipt could not be read.',
        status: read?.status || 'unknown',
      },
      meta: {},
    }, name, args, gate);
  }

  return withMcpToolVerdictSurface({
    ok: true,
    type: 'trust_receipt_detail',
    data: read.receipt,
    evidence: [],
    receiptId: read.receiptId || receiptId,
    error: null,
    meta: { status: read.status },
  }, name, args, gate);
}

module.exports = { executeMcpTrustReceiptDetail };
