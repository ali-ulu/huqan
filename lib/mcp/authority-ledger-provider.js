'use strict';

// Fetches the approval authority ledger for detection (`audit --authority`,
// ADR-016 P6). Lives beside the other MCP inbound surfaces (UI ring) because
// only this ring may reach the authority HTTP client or the receipt index;
// lib/ command handlers take the fetched pages as data and never open the
// connection themselves.
//
// Never throws: an audit is a report, so an unusable authority is reported,
// not raised. Bounded: at most LEDGER_PAGES pages of 500 entries and
// RECEIPT_READS receipt re-reads.

const { resolveApprovalAuthorityMode } = require('../authority/authority-mode');
const { createAuthorityClient } = require('../authority/authority-client');
const { readReceiptById } = require('../receipt/receipt-read-index');

const LEDGER_PAGE_SIZE = 500;
const LEDGER_PAGES = 20;
const RECEIPT_READS = 100;

function defaultDeps() {
  return { resolveMode: resolveApprovalAuthorityMode, createClient: createAuthorityClient, readReceipt: readReceiptById };
}

async function fetchAuthorityLedger({ graph = null, workspaceId = 'default', resolveReceipts = false } = {}, deps = {}) {
  const { resolveMode, createClient, readReceipt } = { ...defaultDeps(), ...deps };
  const mode = resolveMode();
  if (mode.mode !== 'service') return { mode: mode.mode, reason: mode.reason || 'no_pin', entries: [], corrupt: false, receipts: {} };
  const client = createClient({ pin: mode.pin });
  try {
    const entries = [];
    let fromSeq = 0;
    for (let page = 0; page < LEDGER_PAGES; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await client.ledgerEntries({ fromSeq, limit: LEDGER_PAGE_SIZE });
      if (answer.status !== 200 || !answer.body || answer.body.corrupt) {
        return { mode: 'service', entries, corrupt: Boolean(answer.body && answer.body.corrupt), receipts: {} };
      }
      const batch = Array.isArray(answer.body.entries) ? answer.body.entries : [];
      entries.push(...batch);
      if (batch.length < LEDGER_PAGE_SIZE) break;
      fromSeq = batch[batch.length - 1].seq + 1;
    }
    const fetched = { mode: 'service', entries, corrupt: false,
      truncated: entries.length >= LEDGER_PAGE_SIZE * LEDGER_PAGES, receipts: {} };
    if (resolveReceipts) {
      const wanted = [];
      for (const entry of entries) {
        const id = entry && entry.body && entry.body.receiptId;
        if (entry && entry.type === 'approval.outcome' && typeof id === 'string' && id && !wanted.includes(id)) {
          wanted.push(id);
          if (wanted.length >= RECEIPT_READS) break;
        }
      }
      for (const id of wanted) {
        try {
          // eslint-disable-next-line no-await-in-loop
          fetched.receipts[id] = await readReceipt(graph, id, { workspaceId });
        } catch (_) {
          fetched.receipts[id] = null;
        }
      }
    }
    return fetched;
  } catch (error) {
    return { mode: 'service', entries: [], corrupt: false, error: error.code || 'AUTHORITY_UNAVAILABLE', receipts: {} };
  }
}

module.exports = { fetchAuthorityLedger };
