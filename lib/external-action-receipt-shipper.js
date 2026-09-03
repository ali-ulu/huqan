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

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  defaultExternalActionReceiptPath,
} = require('./external-action-receipt');
const {
  parseExternalActionReceiptLines,
  externalActionReceiptIdentity,
} = require('./external-action-identity-log');

const RECEIPT_BATCH_SCHEMA = 'huqan.receipt-batch.v1';
const DEFAULT_BATCH_SIZE = 200;
const MAX_BATCH_SIZE = 1000;

/**
 * Reserved from the first version on purpose. The card that names the agent is
 * signed (#1786), so a collector can tell whose receipts these are -- but the
 * bundle itself is not signed yet (#1788), so it cannot yet be shown to be
 * unchanged since it left the host. Carrying the field now, with an honest
 * `unsigned`, keeps that upgrade from breaking every stored batch.
 */
function bundleSignature() {
  return { status: 'unsigned', algorithm: '', value: '', keyId: '' };
}

function defaultCursorPath(receiptPath) {
  return `${receiptPath}.shipped.json`;
}

function readCursor(target) {
  try {
    const value = JSON.parse(fs.readFileSync(target, 'utf8'));
    return {
      shipped: Number.isInteger(value.shipped) && value.shipped >= 0 ? value.shipped : 0,
      lastReceiptId: typeof value.lastReceiptId === 'string' ? value.lastReceiptId : '',
      lastCreatedAt: typeof value.lastCreatedAt === 'string' ? value.lastCreatedAt : '',
    };
  } catch (_) {
    return { shipped: 0, lastReceiptId: '', lastCreatedAt: '' };
  }
}

function writeCursor(target, cursor) {
  fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
  fs.writeFileSync(target, `${JSON.stringify({ ...cursor, updatedAt: new Date().toISOString() }, null, 2)}\n`, { mode: 0o600 });
}

/**
 * A cursor is a count into an append-only file, which stops being meaningful
 * the moment the file is rotated or truncated. So the receipt it claims to
 * have stopped at is checked; when it does not match, the count is discarded
 * and everything newer than the last shipped timestamp is sent instead. The
 * report says this happened -- a silent resync would look exactly like a
 * collector quietly receiving duplicates.
 */
function unsentReceipts(receipts, cursor) {
  const at = receipts[cursor.shipped - 1];
  if (cursor.shipped > 0 && (!at || at.receiptId !== cursor.lastReceiptId)) {
    const after = cursor.lastCreatedAt;
    return { pending: receipts.filter(receipt => !after || String(receipt.createdAt) > after), resynced: true };
  }
  return { pending: receipts.slice(cursor.shipped), resynced: false };
}

function tenantOf(receipt) {
  const identity = externalActionReceiptIdentity(receipt) || {};
  return {
    workspaceId: String(receipt.workspaceId || identity.workspaceId || 'default'),
    ownerActorId: String(identity.ownerActorId || 'unattested'),
  };
}

/**
 * Batches are runs of consecutive same-tenant receipts, not per-tenant piles.
 * Both properties are needed at once: a batch must hold exactly one tenant,
 * and the trail must go out in order -- because the cursor is a position in an
 * append-only file, and reordering would let it mark a receipt as shipped that
 * never was.
 */
function batchByTenantRuns(receipts, batchSize) {
  const batches = [];
  let current = null;
  for (const receipt of receipts) {
    const tenant = tenantOf(receipt);
    const key = `${tenant.workspaceId}::${tenant.ownerActorId}`;
    if (!current || current.key !== key || current.receipts.length >= batchSize) {
      current = { key, tenant, receipts: [] };
      batches.push(current);
    }
    current.receipts.push(receipt);
  }
  return batches;
}

function buildReceiptBatch({ tenant, receipts, source = {}, now = () => new Date().toISOString() }) {
  const body = {
    schemaVersion: RECEIPT_BATCH_SCHEMA,
    batchId: `rcpt_batch_${crypto.randomUUID().replace(/-/g, '')}`,
    createdAt: now(),
    tenant: { workspaceId: tenant.workspaceId, ownerActorId: tenant.ownerActorId },
    source: { host: String(source.host || ''), trail: String(source.trail || '') },
    bundleSignature: bundleSignature(),
    count: receipts.length,
    receipts,
  };
  // Not a signature and never described as one: it lets a collector drop a
  // batch it already stored, and detect a transport that mangled one.
  body.contentHash = `sha256:${crypto.createHash('sha256').update(JSON.stringify(body.receipts)).digest('hex')}`;
  return body;
}

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
  return { batchId: batch.batchId, status: response.status };
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
  const batches = batchByTenantRuns(pending, batchSize).map(group => buildReceiptBatch({
    ...group,
    source: { host: options.host || '', trail: receiptPath },
    ...(options.now ? { now: options.now } : {}),
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
  for (const batch of batches) {
    try {
      if (deliver) {
        const delivered = await deliver(batch);
        if (delivered && delivered.ok === false) {
          throw new Error(`collector refused batch ${batch.batchId}: ${delivered.error?.code || delivered.status || 'unknown'}`);
        }
      } else {
        await postBatch(endpoint, batch, settings);
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
  shipExternalActionReceipts,
});
