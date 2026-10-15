'use strict';

const { readReceiptById } = require('./receipt/receipt-read-index');

function cliError(message, exitCode = 1, meta) {
  const error = new Error(message);
  error.exitCode = exitCode;
  if (meta) error.meta = meta;
  return error;
}

function requireReceiptArgs(args, usage) {
  const receiptId = String(args?.receiptId || '').trim();
  const workspaceId = String(args?.workspaceId || '').trim();
  if (!receiptId || receiptId.startsWith('--') || !workspaceId) throw cliError(`Usage: ${usage}`, 2);
  return { receiptId, workspaceId };
}

function runCliTrustReceipt(kernel, args, opts = {}) {
  const { receiptId, workspaceId } = requireReceiptArgs(args, 'receipt <id> [--workspace <id>]');

  const read = readReceiptById(kernel.graph, receiptId, { workspaceId });
  if (!read.ok) {
    const code = read.error?.code || 'RECEIPT_UNAVAILABLE';
    throw cliError(`Trust Receipt unavailable: ${code}: ${read.error?.message || read.status}`);
  }
  return opts.json
    ? { status: 'completed', data: { receipt: read.receipt, workspaceId }, receiptId }
    : JSON.stringify({ receipt: read.receipt, workspaceId }, null, 2);
}

/**
 * #3892: verify the chain a receipt sits in -- its workspace and receipt
 * family, from genesis to the recorded tip -- not the receipt on its own.
 * readReceiptById already rebuilds that chain and checks its head against the
 * tip written at commit time; this reports the verdict instead of the payload,
 * and a broken chain exits non-zero with the reason in the error's meta.
 */
function runCliVerifyReceipt(kernel, args, opts = {}) {
  const { receiptId, workspaceId } = requireReceiptArgs(args, 'receipt verify <id> [--workspace <id>]');

  const read = readReceiptById(kernel.graph, receiptId, { workspaceId });
  const chain = read.chainValidation || null;
  const verdict = {
    verdict: read.ok ? 'valid' : (read.status === 'not_found' ? 'not_found' : 'invalid'),
    receiptId,
    workspaceId,
    receiptHash: read.chainedReceipt?.receiptHash || null,
    previousReceiptHash: read.chainedReceipt?.previousReceiptHash || null,
    chain,
  };
  if (!read.ok) {
    const code = read.error?.code || 'RECEIPT_UNAVAILABLE';
    const reason = chain?.reason ? ` (${chain.reason}${Number.isInteger(chain.brokenAt) ? ` at ${chain.brokenAt}` : ''})` : '';
    throw cliError(`Trust Receipt does not verify: ${code}: ${read.error?.message || read.status}${reason}`, 1, verdict);
  }
  return opts.json
    ? { status: 'completed', data: verdict, receiptId }
    : `Trust Receipt ${receiptId} verifies: its chain in workspace ${workspaceId} is intact from genesis to the recorded tip (receiptHash ${verdict.receiptHash}).`;
}

module.exports = { runCliTrustReceipt, runCliVerifyReceipt };
