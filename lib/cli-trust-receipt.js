'use strict';

const { readReceiptById } = require('./receipt/receipt-read-index');

function cliError(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

function runCliTrustReceipt(kernel, args, opts = {}) {
  const receiptId = String(args?.receiptId || '').trim();
  const workspaceId = String(args?.workspaceId || '').trim();
  if (!receiptId || !workspaceId) throw cliError('Usage: receipt <id> [--workspace <id>]', 2);

  const read = readReceiptById(kernel.graph, receiptId, { workspaceId });
  if (!read.ok) {
    const code = read.error?.code || 'RECEIPT_UNAVAILABLE';
    throw cliError(`Trust Receipt unavailable: ${code}: ${read.error?.message || read.status}`);
  }
  return opts.json
    ? { status: 'completed', data: { receipt: read.receipt, workspaceId }, receiptId }
    : JSON.stringify({ receipt: read.receipt, workspaceId }, null, 2);
}

module.exports = { runCliTrustReceipt };
