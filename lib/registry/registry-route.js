'use strict';

/**
 * The registry admission and read surface (#1787, Faz F).
 *
 *   POST /api/registry/records          register an identity the receiver holds
 *   GET  /api/registry/records/:id      read one, trust root re-resolved live
 *
 * ## What this route is and is not
 *
 * It is the distribution layer the issue calls the missing CA: somewhere a
 * receiver can record "this identity, this key" so that trust stops being
 * hand-copied between authority files.
 *
 * It is deliberately **not** discovery. There is no listing endpoint and no
 * public path. `lib/a2a/agent-card.js` refuses to publish key material with the
 * reasoning that publishing a key set is a disclosure decision of its own; that
 * decision is still not made here, so this surface answers only about a record
 * whose id the caller already has, and only to an authenticated caller.
 *
 * ## Why it 404s when unconfigured
 *
 * Same reason as the A2A routes beside it: a declared-but-unbuildable route
 * turns a configuration mistake into an externally observable 401, which tells
 * an unauthenticated caller the surface exists. Both the authority and the
 * record directory must be usable before the route is declared at all.
 *
 * ## The read is where revocation actually lands
 *
 * A stored record's `resolvedKeyState` is history, not permission. Every read
 * re-resolves the trust root through the receiver's own authority, so revoking
 * a key takes effect for readers immediately instead of only for whoever
 * remembered to edit a file. That is the sharper half of the gap #1787
 * describes, and it is why there is no cache in here.
 */

const path = require('node:path');
const fs = require('node:fs');

const {
  resolveA2aBoundaryPaths,
  constructA2aBoundaryDependencies,
} = require('../a2a/exchange-route');
const { authorityTrustedKeyRecords } = require('../a2a/bounded-exchange');
const { CAPABILITIES, SUPPORTED_PROTOCOL_VERSIONS } = require('../a2a/agent-card');
const { readCompatibleEnvironmentVariable } = require('../environment-compat');
const { admitRegistryRecord, resolveRegistryRecordForRead } = require('./registry-record-shape');
const { createRegistryRecordStore, RECORD_ID_PATTERN } = require('./registry-record-store');

const REGISTRY_COLLECTION_PATH = '/api/registry/records';
const MAX_BODY_BYTES = 16 * 1024;

const REGISTRY_ROUTE_ERRORS = Object.freeze({
  METHOD: 'registry_method_not_allowed',
  NOT_FOUND: 'registry_record_not_found',
  UNAVAILABLE: 'registry_store_unavailable',
});

/**
 * Resolve the record directory from options or environment.
 *
 * Absolute and real, checked the same way the exchange route checks its
 * authority path: a symlinked registry directory would let whoever controls
 * the link decide where admitted identities are written.
 */
function resolveRegistryDirectory(options = {}) {
  const configured = options.registryDirectory !== undefined
    ? options.registryDirectory
    // Through environment-compat, not process.env: a direct read loses the
    // AXIOM_ fallback and, worse, the HUQAN_ENV_CONFLICT check that fails
    // closed when both spellings are set to different values.
    : readCompatibleEnvironmentVariable('REGISTRY_DIR');
  const directory = String(configured || '').trim();
  if (!directory || !path.isAbsolute(directory)) return null;
  try {
    const resolved = path.resolve(directory);
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
    if (fs.realpathSync.native(resolved) !== resolved) return null;
    return resolved;
  } catch (_) {
    return null;
  }
}

function receiverCapabilityIds() {
  return CAPABILITIES.map((capability) => capability.id);
}

/**
 * Build the boundary, or return null when the deployment cannot serve it.
 *
 * Null rather than a route that always refuses: `route-auth-policy` turns the
 * null into a 404, which is the answer an undeclared surface owes.
 */
function createRegistryBoundary(options = {}) {
  const directory = resolveRegistryDirectory(options);
  if (directory === null) return null;

  const dependencies = constructA2aBoundaryDependencies(resolveA2aBoundaryPaths(options));
  if (!dependencies || !dependencies.authority) return null;

  let store;
  try {
    store = createRegistryRecordStore(directory);
  } catch (_) {
    return null;
  }

  const { authority } = dependencies;
  // Built once, from the same authority the exchange enforces. A second
  // reading of the same file would be a second key authority, and the failure
  // that follows is a registry admitting a key the exchange rejects.
  const trustedKeyRecords = authorityTrustedKeyRecords(authority);
  if (trustedKeyRecords === null) return null;

  const parseJsonRequest = (...args) => options.getParseJsonRequest()(...args);
  const writeJson = (...args) => options.getWriteJson()(...args);

  return Object.freeze({ route });

  async function route(req, res, reqUrl) {
    const pathname = String(reqUrl.pathname || '');
    if (pathname === REGISTRY_COLLECTION_PATH) return handleRegistration(req, res);
    if (pathname.startsWith(`${REGISTRY_COLLECTION_PATH}/`)) {
      return handleRead(req, res, pathname.slice(REGISTRY_COLLECTION_PATH.length + 1));
    }
    return false;
  }

  async function handleRegistration(req, res) {
    if (String(req.method || '').toUpperCase() !== 'POST') {
      writeJson(req, res, 405, { decision: 'block', reason: REGISTRY_ROUTE_ERRORS.METHOD });
      return true;
    }

    let body;
    try {
      body = await parseJsonRequest(req, res, { maxBytes: MAX_BODY_BYTES });
    } catch (_) {
      return true; // parseJsonRequest already answered.
    }
    if (body === undefined || body === null) return true;

    // The existing record is read first so a re-registration bumps its version
    // rather than resetting it. A read failure is not treated as "no record":
    // that would silently restart the version history at 1 and hide the fact
    // that this identity was registered before.
    let existingRecord = null;
    try {
      existingRecord = readExistingRecord(body);
    } catch (_) {
      writeJson(req, res, 503, { decision: 'block', reason: REGISTRY_ROUTE_ERRORS.UNAVAILABLE });
      return true;
    }

    const admission = admitRegistryRecord({
      request: body,
      authority,
      existingRecord,
      evaluationTime: authority.evaluationTime,
      receiverCapabilityIds: receiverCapabilityIds(),
      supportedProtocolVersions: SUPPORTED_PROTOCOL_VERSIONS,
      trustedKeyRecords,
    });

    if (!admission.ok) {
      writeJson(req, res, 400, {
        decision: 'block',
        reason: admission.reasonCategory,
        ...(admission.resolvedKeyState ? { resolvedKeyState: admission.resolvedKeyState } : {}),
      });
      return true;
    }

    let recordId;
    try {
      recordId = store.put(admission.record);
    } catch (_) {
      // The record was admitted but not durably stored, so nothing is claimed:
      // answering 201 here would hand out an id no later read can resolve.
      writeJson(req, res, 503, { decision: 'block', reason: REGISTRY_ROUTE_ERRORS.UNAVAILABLE });
      return true;
    }

    writeJson(req, res, 201, { decision: 'admit', recordId, record: admission.record }, { 'Cache-Control': 'no-store' });
    return true;
  }

  /**
   * Look up the current record for the identity a registration names.
   *
   * A malformed body has no identity to look up, so it resolves to null and
   * the admission step rejects it on its own terms -- this function never
   * decides admission, only supplies the version predecessor.
   */
  function readExistingRecord(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const { workspaceId, identityRef } = body;
    if (typeof workspaceId !== 'string' || typeof identityRef !== 'string') return null;
    if (workspaceId === '' || identityRef === '') return null;
    return store.read(store.registryRecordId({ workspaceId, identityRef }));
  }

  function handleRead(req, res, recordId) {
    if (String(req.method || '').toUpperCase() !== 'GET') {
      writeJson(req, res, 405, { decision: 'block', reason: REGISTRY_ROUTE_ERRORS.METHOD });
      return true;
    }

    // An id that is not even shaped like one is answered exactly like an id
    // that is: a caller must not be able to tell a malformed id from an absent
    // record, because that difference is a probe.
    let stored = null;
    if (RECORD_ID_PATTERN.test(String(recordId || ''))) {
      try {
        stored = store.read(recordId);
      } catch (_) {
        writeJson(req, res, 503, { decision: 'block', reason: REGISTRY_ROUTE_ERRORS.UNAVAILABLE });
        return true;
      }
    }
    if (stored === null) {
      writeJson(req, res, 404, { decision: 'block', reason: REGISTRY_ROUTE_ERRORS.NOT_FOUND });
      return true;
    }

    const read = resolveRegistryRecordForRead({
      record: stored,
      evaluationTime: authority.evaluationTime,
      trustedKeyRecords,
    });
    if (!read.ok) {
      // Excluded, not deleted: the record stays for an operator to inspect,
      // but a reader is told the trust root no longer resolves rather than
      // handed a copy that still says `active`.
      writeJson(req, res, 409, {
        decision: 'block',
        reason: read.reasonCategory,
        ...(read.resolvedKeyState ? { resolvedKeyState: read.resolvedKeyState } : {}),
      });
      return true;
    }

    writeJson(req, res, 200, { decision: 'admit', recordId, record: read.record }, { 'Cache-Control': 'no-store' });
    return true;
  }
}

module.exports = Object.freeze({
  REGISTRY_COLLECTION_PATH,
  REGISTRY_ROUTE_ERRORS,
  MAX_BODY_BYTES,
  createRegistryBoundary,
});
