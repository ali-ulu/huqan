'use strict';

/**
 * Get the evidence off the machine that produced it (#1781).
 *
 * The guard's distinctive half is not the blocking, it is the receipt -- and a
 * receipt in a local JSONL answers no question for the person who needs it,
 * because that person is not the one running the agent. This ships the trail
 * to a collector.
 *
 * Three properties this is built around:
 *
 * - **It never touches the guard's decision path.** Shipping runs as its own
 *   command, after the fact. A collector being down, slow, or wrong must not
 *   be able to change what an agent is allowed to do, or add a network round
 *   trip to a tool call.
 * - **The append-only trail is the queue.** Offline tolerance needs no second
 *   spool: a failed send simply leaves the cursor where it was, so the next
 *   run re-sends from the same place. What is on disk stays the source of
 *   truth until a collector has acknowledged it.
 * - **Tenants are separated at the source.** Receipts are grouped by
 *   workspace and owner before sending, so a batch never mixes two tenants
 *   and a collector never has to split one.
 */

const fs = require('node:fs');
const path = require('node:path');
const {
  defaultExternalActionReceiptPath,
} = require('./external-action-receipt');
const {
  parseExternalActionReceiptLines,
} = require('./external-action-identity-log');
const {
  RECEIPT_BATCH_SCHEMA,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  readSigningKey,
  batchByTenantRuns,
  buildReceiptBatch,
} = require('./external-action-receipt-batch');
const {
  defaultCursorPath,
  readCursor,
  writeCursor,
  unsentReceipts,
} = require('./external-action-receipt-cursor');

async function postBatch(endpoint, batch, { token, fetchImpl, timeoutMs }) {
  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(batch),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response || !response.ok) {
    const status = response ? response.status : 0;
    throw new Error(`collector rejected batch ${batch.batchId}: HTTP ${status}`);
  }
  // The body carries the collector's counter-seal when it makes one. A body
  // that will not parse is not a shipping failure -- the batch was accepted --
  // so the seal is simply absent (#1882).
  let body = null;
  try { body = await response.json(); } catch (_) { body = null; }
  return { batchId: batch.batchId, status: response.status, seal: body && body.seal ? body.seal : null };
}

/**
 * Ships everything the cursor has not acknowledged yet.
 *
 * Stops at the first failed batch and leaves the cursor at the last one the
 * collector accepted: re-sending an accepted batch is cheap (the collector can
 * drop it by `batchId`/`contentHash`), while advancing past a rejected one
 * would lose evidence, which is the one thing this must never do.
 */
async function shipExternalActionReceipts(options = {}) {
  const receiptPath = path.resolve(options.path || defaultExternalActionReceiptPath(options.environment || process.env));
  const cursorPath = path.resolve(options.cursorPath || defaultCursorPath(receiptPath));
  const batchSize = Math.min(Math.max(Number.parseInt(options.batchSize, 10) || DEFAULT_BATCH_SIZE, 1), MAX_BATCH_SIZE);
  const endpoint = String(options.endpoint || '').trim();
  const dryRun = Boolean(options.dryRun);
  // A deployment that keeps its collector on the same host -- or on a share it
  // already trusts -- should not have to stand up HTTP to get evidence off the
  // agent's machine. `deliver` is that transport: same batches, same cursor,
  // no endpoint. The caller supplies it so this module never has to know what
  // is on the other side (and so the collector can depend on this one, not the
  // other way around).
  const deliver = typeof options.deliver === 'function' ? options.deliver : null;
  if (!dryRun && !endpoint && !deliver) throw new Error('shipping requires an endpoint, a deliver function, or --dry-run');

  let raw = '';
  try { raw = fs.readFileSync(receiptPath, 'utf8'); } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
  const { receipts, skipped } = parseExternalActionReceiptLines(raw);
  const cursor = readCursor(cursorPath);
  const { pending, resynced } = unsentReceipts(receipts, cursor);
  // Read before the first batch is built, so a misconfigured key fails the run
  // with nothing shipped rather than part way through it.
  const signingKey = readSigningKey(options);
  const batches = batchByTenantRuns(pending, batchSize).map(group => buildReceiptBatch({
    ...group,
    source: { host: options.host || '', trail: receiptPath },
    ...(options.now ? { now: options.now } : {}),
    signingKey,
  }));

  const report = {
    trail: receiptPath,
    cursorPath,
    scanned: receipts.length,
    skippedLines: skipped,
    pending: pending.length,
    resynced,
    dryRun,
    batches: batches.map(batch => ({
      batchId: batch.batchId,
      tenant: batch.tenant,
      count: batch.count,
      contentHash: batch.contentHash,
      bundleSignature: batch.bundleSignature.status,
    })),
    shipped: 0,
    // Counter-seals this run brought back. Reported separately from `shipped`
    // because a collector that stores without sealing is a real deployment,
    // and reading one number as the other would overstate the evidence.
    sealed: 0,
    failure: null,
  };
  if (dryRun || !pending.length) return Object.freeze(report);

  const fetchImpl = deliver ? null : (options.fetchImpl || globalThis.fetch);
  if (!deliver && typeof fetchImpl !== 'function') throw new Error('no fetch implementation available for shipping');
  const settings = {
    token: options.token || (options.environment || process.env).HUQAN_RECEIPT_COLLECTOR_TOKEN || '',
    fetchImpl,
    timeoutMs: Number.parseInt(options.timeoutMs, 10) || 30000,
  };

  // Where `pending` starts in the trail. Taken from the tail length rather
  // than the stored count, so it is right after a resync too.
  const baseIndex = receipts.length - pending.length;
  const sealPath = path.resolve(options.sealPath || `${receiptPath}.seals.jsonl`);
  for (const batch of batches) {
    try {
      let seal = null;
      if (deliver) {
        const delivered = await deliver(batch);
        if (delivered && delivered.ok === false) {
          throw new Error(`collector refused batch ${batch.batchId}: ${delivered.error?.code || delivered.status || 'unknown'}`);
        }
        seal = delivered && delivered.seal ? delivered.seal : null;
      } else {
        seal = (await postBatch(endpoint, batch, settings)).seal;
      }
      // The collector's counter-seal is kept beside the trail, because it is
      // the one piece of evidence this host cannot produce for itself: proof
      // that a specific batch reached a specific collector (#1882). Failing to
      // store it must not undo a shipment that already succeeded.
      if (seal) {
        try {
          fs.appendFileSync(sealPath, `${JSON.stringify(seal)}\n`, { mode: 0o600 });
          report.sealed += 1;
        } catch (_) { /* the batch is shipped either way */ }
      }
    } catch (error) {
      // Everything before this batch is acknowledged; everything from it on
      // stays pending. The trail is untouched either way.
      report.failure = { batchId: batch.batchId, message: String((error && error.message) || error) };
      break;
    }
    report.shipped += batch.count;
    const last = batch.receipts[batch.receipts.length - 1];
    writeCursor(cursorPath, {
      shipped: baseIndex + report.shipped,
      lastReceiptId: String(last.receiptId || ''),
      lastCreatedAt: String(last.createdAt || cursor.lastCreatedAt || ''),
    });
  }
  return Object.freeze(report);
}

module.exports = Object.freeze({
  RECEIPT_BATCH_SCHEMA,
  DEFAULT_BATCH_SIZE,
  MAX_BATCH_SIZE,
  defaultReceiptCursorPath: defaultCursorPath,
  buildReceiptBatch,
  readSigningKey,
  shipExternalActionReceipts,
});
