'use strict';

/**
 * Durable storage for registry records (#1787, Faz F).
 *
 * ## Why the record id is derived, not handed out
 *
 * A registry's job is to have exactly one current answer for "who is this
 * identity". If the id were a fresh value per registration, a re-registration
 * would create a second row and the registry would hold two contradictory
 * answers with no way to tell which is current. So the id is derived from the
 * identity itself -- workspace plus identity ref, domain-separated -- which
 * makes "one identity, one row, a version history" a property of addressing
 * rather than a rule someone has to remember to enforce.
 *
 * The derivation is a hash rather than the identity in the clear because the id
 * appears in URLs and logs, and an identity ref is a name the receiver holds,
 * not something this layer decides to publish. Publication is a separate,
 * explicit decision (`lib/a2a/agent-card.js` refuses it for the same reason).
 *
 * ## Why a write may overwrite here, and why that is not the replay store
 *
 * `lib/a2a/replay-store.js` writes with `wx` because its exclusive-create *is*
 * the at-most-once guarantee. This store is the opposite kind of thing: a
 * current-value record whose whole purpose is to be superseded when the
 * identity re-registers. Borrowing the replay store's exclusive-create would
 * make a legitimate version bump fail. What is preserved instead is that a
 * write lands whole -- write to a temporary file, fsync, rename -- so a reader
 * never observes a half-written record, and a crash leaves the previous
 * version standing rather than a truncated one.
 *
 * This is the V4 journal family's discipline (bounded records, atomic
 * placement, no second database), not a new store: the directory is a plain
 * directory of JSON files, inspectable with the tools an operator already has.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RECORD_ID_DOMAIN = 'HUQAN/V5/F/REGISTRY-RECORD-ID/v1';
const RECORD_ID_PATTERN = /^[0-9a-f]{64}$/;
const MAX_RECORD_BYTES = 16 * 1024;

/**
 * Derive the record id for an identity.
 *
 * The two components are length-prefixed before hashing so that no pair of
 * different identities can produce the same input bytes -- without it,
 * workspace `a` + ref `bc` and workspace `ab` + ref `c` would collide, which
 * would let one identity's registration overwrite another's row.
 */
function registryRecordId({ workspaceId, identityRef }) {
  if (typeof workspaceId !== 'string' || typeof identityRef !== 'string'
    || workspaceId === '' || identityRef === '') {
    throw new Error('registry record id requires workspaceId and identityRef');
  }
  const material = `${RECORD_ID_DOMAIN}:${workspaceId.length}:${workspaceId}:${identityRef.length}:${identityRef}`;
  return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
}

function createRegistryRecordStore(directory) {
  const root = path.resolve(directory);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.realpathSync.native(root) !== root) {
    throw new Error('registry record directory must be a real directory');
  }

  return Object.freeze({ put, read, registryRecordId });

  function targetFor(recordId) {
    if (!RECORD_ID_PATTERN.test(String(recordId || ''))) throw new Error('registry record id is invalid');
    return path.join(root, `${recordId}.json`);
  }

  /**
   * Store a record as the current answer for its identity, and return its id.
   *
   * The rename is what makes the write atomic for readers; the temporary file
   * carries the record id so two concurrent writers for *different* identities
   * cannot collide on it.
   */
  function put(record) {
    const recordId = registryRecordId(record);
    const payload = JSON.stringify({ recordId, record });
    if (Buffer.byteLength(payload, 'utf8') > MAX_RECORD_BYTES) throw new Error('registry record too large');

    const target = targetFor(recordId);
    const staging = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    let descriptor;
    try {
      descriptor = fs.openSync(staging, 'wx', 0o600);
      fs.writeFileSync(descriptor, payload, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(staging, target);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      // A staging file left behind by a failed write is removed rather than
      // retried: it is not a record, and leaving it would grow the directory
      // with material no reader will ever look at.
      try { if (fs.existsSync(staging)) fs.unlinkSync(staging); } catch (_) { /* nothing to clean */ }
    }
    return recordId;
  }

  /**
   * Read the stored record for an id, or null.
   *
   * Null covers "never registered" and "stored bytes this process cannot
   * account for" alike, on purpose: a record that does not parse must not be
   * served as if it were a registration the receiver made. The caller
   * re-resolves the trust root regardless, so a stored record is only ever a
   * candidate, never an authorization.
   */
  function read(recordId) {
    let bytes;
    try {
      bytes = fs.readFileSync(targetFor(recordId), 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return null;
    }
    let parsed;
    try {
      parsed = JSON.parse(bytes);
    } catch (_) {
      return null;
    }
    if (!parsed || parsed.recordId !== recordId || !parsed.record) return null;
    // Re-derive from the stored record's own identity: a file whose contents
    // name a different identity than its filename claims is a mismatch this
    // layer refuses rather than resolves.
    try {
      if (registryRecordId(parsed.record) !== recordId) return null;
    } catch (_) {
      return null;
    }
    return Object.freeze(parsed.record);
  }
}

module.exports = Object.freeze({
  MAX_RECORD_BYTES,
  RECORD_ID_PATTERN,
  createRegistryRecordStore,
  registryRecordId,
});
