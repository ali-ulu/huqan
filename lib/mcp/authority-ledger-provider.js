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
const { createRekorAnchorClient } = require('./rekor-anchor-client');
const { indexByAnchorDigest } = require('../authority-anchor-detection');

const LEDGER_PAGE_SIZE = 500;
const LEDGER_PAGES = 20;
const RECEIPT_READS = 100;
// When an anchor is older than the fetched window, the ledger is read from
// its start up to the window, at most this many pages (100,000 entries).
const ANCHOR_SCAN_PAGES = 200;

function defaultDeps() {
  return { resolveMode: resolveApprovalAuthorityMode, createClient: createAuthorityClient, readReceipt: readReceiptById,
    createRekorClient: createRekorAnchorClient };
}

// Reads the ledger before the fetched window into the digest index until every
// wanted digest is there or the ledger start is reached. True when the read
// covered all it had to, so a digest still absent is truly not in the ledger.
async function indexBeforeWindow(client, windowStartSeq, index, wanted) {
  let fromSeq = 0;
  for (let page = 0; page < ANCHOR_SCAN_PAGES && fromSeq < windowStartSeq; page += 1) {
    // eslint-disable-next-line no-await-in-loop
    const answer = await client.ledgerEntries({ fromSeq, limit: LEDGER_PAGE_SIZE });
    const batch = answer.status === 200 && answer.body && !answer.body.corrupt && Array.isArray(answer.body.entries)
      ? answer.body.entries.filter(entry => entry && entry.seq < windowStartSeq) : null;
    if (!batch || batch.length === 0) return false;
    indexByAnchorDigest(batch, index);
    if (wanted.every(digest => index.has(digest))) return true;
    fromSeq = batch[batch.length - 1].seq + 1;
  }
  return fromSeq >= windowStartSeq;
}

// #3940: every anchor in Rekor under the pinned anchor key, each with the
// ledger entry it names or null. Never throws; an unusable log is reported.
async function fetchAnchors(client, pin, fetched, rekor) {
  if (!pin.anchorKey) return { error: 'ANCHOR_KEY_NOT_PINNED' };
  let found;
  try {
    found = await rekor.findAnchors(pin.anchorKey);
  } catch (error) {
    return { error: error.code || 'REKOR_UNAVAILABLE' };
  }
  const readable = !fetched.error && !fetched.corrupt;
  const index = indexByAnchorDigest(readable ? fetched.entries : []);
  const wanted = found.anchors.map(anchor => anchor.digest).filter(digest => !index.has(digest));
  let scanned = readable;
  if (readable && wanted.length > 0 && fetched.truncated && fetched.entries.length > 0) {
    scanned = await indexBeforeWindow(client, fetched.entries[0].seq, index, wanted);
  }
  return { count: found.anchors.length, unverified: found.unverified, truncated: found.truncated, publicKey: pin.anchorKey,
    scanned, anchors: found.anchors.map(anchor => ({ ...anchor, match: index.get(anchor.digest) || null })) };
}

async function fetchAuthorityLedger({ graph = null, workspaceId = 'default', resolveReceipts = false, anchors = false } = {}, deps = {}) {
  const { resolveMode, createClient, readReceipt, createRekorClient } = { ...defaultDeps(), ...deps };
  const mode = resolveMode();
  if (mode.mode !== 'service') return { mode: mode.mode, reason: mode.reason || 'no_pin', entries: [], corrupt: false, receipts: {} };
  const client = createClient({ pin: mode.pin });
  try {
    const entries = [];
    // The newest window: the local side compares its newest rows, so the
    // ledger side must be the newest entries too, not the oldest.
    const head = await client.ledgerHead();
    if (head.status !== 200 || !head.body || !Number.isInteger(head.body.seq)) {
      return { mode: 'service', entries: [], corrupt: false, error: 'AUTHORITY_UNAVAILABLE', receipts: {} };
    }
    const headSeq = head.body.seq;
    let fromSeq = Math.max(0, headSeq - LEDGER_PAGE_SIZE * LEDGER_PAGES + 1);
    for (let page = 0; page < LEDGER_PAGES; page += 1) {
      // eslint-disable-next-line no-await-in-loop
      const answer = await client.ledgerEntries({ fromSeq, limit: LEDGER_PAGE_SIZE });
      if (answer.status !== 200 || !answer.body || answer.body.corrupt) {
        // A window that stopped part way is not the ledger: report it, never compare against it.
        const corrupt = Boolean(answer.body && answer.body.corrupt);
        return { mode: 'service', entries, corrupt, truncated: true, receipts: {},
          ...(corrupt ? {} : { error: 'AUTHORITY_UNAVAILABLE' }) };
      }
      const batch = Array.isArray(answer.body.entries) ? answer.body.entries : [];
      entries.push(...batch);
      if (batch.length < LEDGER_PAGE_SIZE) break;
      fromSeq = batch[batch.length - 1].seq + 1;
    }
    const fetched = { mode: 'service', entries, corrupt: false, truncated: fromSeq > 0 || headSeq >= entries.length, receipts: {} };
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
          const read = await readReceipt(graph, id, { workspaceId });
          // The receipt itself, as apply hashed it -- never the read wrapper.
          fetched.receipts[id] = read && read.ok ? read.receipt : null;
        } catch (_) {
          fetched.receipts[id] = null;
        }
      }
    }
    if (anchors) fetched.anchors = await fetchAnchors(client, mode.pin, fetched, createRekorClient());
    return fetched;
  } catch (error) {
    return { mode: 'service', entries: [], corrupt: false, error: error.code || 'AUTHORITY_UNAVAILABLE', receipts: {} };
  }
}

// Stop recording waits at most this long: the stop already holds locally, so
// a slow or squatted port must not keep the operator's terminal waiting.
const STOP_RECORD_TIMEOUT_MS = 2000;

/**
 * Records the stop entry the local emergency-stop ledger just wrote in the authority's
 * ledger (#3892), so `audit --authority` can tell when a stop later vanishes
 * from the local ledger. Called by the CLI, HTTP and MCP surfaces after
 * stop() returns, never before: the brake never waits on the authority.
 *
 * Never throws. Returns `{ recorded: true, ledgerSeq }`, or
 * `{ recorded: false, reason }` (legacy mode, nothing new to record, or the
 * authority refused or could not be reached).
 */
async function recordAuthorityStop(ledgerEntry, deps = {}) {
  const { resolveMode, createClient } = { ...defaultDeps(), ...deps };
  try {
    const mode = resolveMode();
    if (mode.mode !== 'service') return { recorded: false, reason: mode.mode };
    if (!ledgerEntry || ledgerEntry.action !== 'stop') return { recorded: false, reason: 'not_created' };
    const client = createClient({ pin: mode.pin, timeoutMs: STOP_RECORD_TIMEOUT_MS });
    // Every field comes from the local ledger entry itself, so the authority
    // records exactly what the local chain holds under that hash.
    const { workspaceId, scope, agentId, reason, actor, seq, hash, createdAt } = ledgerEntry;
    const answer = await client.recordStop({ workspaceId, scope, agentId: agentId ?? null, reason, actor,
      localSeq: seq, localHash: hash, stoppedAt: createdAt });
    if ((answer.status === 200 || answer.status === 201) && answer.body && answer.body.stop) {
      return { recorded: true, ledgerSeq: answer.body.stop.ledgerSeq };
    }
    return { recorded: false, reason: (answer.body && answer.body.code) || `HTTP_${answer.status}` };
  } catch (error) {
    return { recorded: false, reason: (error && error.code) || 'AUTHORITY_UNAVAILABLE' };
  }
}

module.exports = { fetchAuthorityLedger, recordAuthorityStop };
