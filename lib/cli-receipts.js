'use strict';

// `huqan receipts verify` (#3860 P6 detection).
//
//   receipts verify <receiptId> [--workspace <id>]
//
// A read-only surface: it reads the receipt by id and validates the receipt's
// own hash-chain self-consistency with lib/receipt/receipt-chain.js (the same
// validator the store and the audit bundle use). A tampered field, a wrong
// receipt hash or a missing linkage to its predecessor is a finding. Findings
// exit 1; a receipt that does not exist exits 1 with the standard
// RECEIPT_UNAVAILABLE code. Reporting an authority ledger match here would
// need the receipt to know its approval; that cross-check is
// `audit --authority`'s job, and this report says so.

const { readReceiptById } = require('./receipt/receipt-read-index');
const { validateReceiptChain } = require('./receipt/receipt-chain');

function cliError(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

function parseReceiptsArgs(raw) {
  const tokens = (Array.isArray(raw) ? raw : String(raw || '').trim().split(/\s+/u))
    .map(String).filter(Boolean);
  if (tokens.shift() !== 'verify') {
    throw cliError('Usage: receipts verify <receiptId> [--workspace <id>]', 2);
  }
  const flags = { receiptId: '', workspaceId: 'default' };
  for (let i = 0; i < tokens.length; i += 1) {
    if (tokens[i] === '--workspace' || tokens[i] === '-w') {
      flags.workspaceId = String(tokens[i + 1] || '').trim() || 'default';
      i += 1;
    } else if (!flags.receiptId) {
      flags.receiptId = tokens[i];
    } else {
      throw cliError('Usage: receipts verify <receiptId> [--workspace <id>]', 2);
    }
  }
  if (!flags.receiptId) throw cliError('Usage: receipts verify <receiptId> [--workspace <id>]', 2);
  return flags;
}

function runCliReceipts(kernel, args, opts = {}, deps = {}) {
  const flags = parseReceiptsArgs(args);
  const read = readReceiptById(kernel?.graph, flags.receiptId, { workspaceId: flags.workspaceId });
  if (!read.ok) {
    const code = read.error?.code || 'RECEIPT_UNAVAILABLE';
    throw cliError(`Trust Receipt unavailable: ${code}: ${read.error?.message || read.status}`, 1);
  }
  const report = {
    schemaVersion: 'huqan-receipts-verify-v1',
    generatedAt: new Date().toISOString(),
    receiptId: flags.receiptId,
    workspaceId: flags.workspaceId,
    chainValid: false,
    findings: [],
  };
  try {
    const check = validateReceiptChain([read.receipt]);
    report.chainValid = check?.valid === true;
    if (!report.chainValid && check) report.findings.push({ code: 'RECEIPT_CHAIN_INVALID', detail: check.reason || 'broken' });
  } catch (error) {
    report.findings.push({ code: 'RECEIPT_CHAIN_INVALID', detail: error?.message || 'validation failed' });
  }
  report.limitations = ['The approval authority cross-check is audit --authority, not this report.'];
  if (report.findings.length > 0) process.exitCode = 1;
  return opts.json
    ? { status: 'completed', data: report }
    : JSON.stringify(report, null, 2);
}

module.exports = { runCliReceipts, parseReceiptsArgs };
