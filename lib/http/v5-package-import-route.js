'use strict';

/**
 * POST /api/v5/packages — Shared Trust Package import.
 *
 * First production caller of the V5 runtime family, as bounded by
 * docs/v5/v5-verification-first-caller-and-authority-boundary.md.
 *
 * Chain (library surface only, no kernel, no store):
 *   validateSharedTrustPackage      (schema: is it a valid package?)
 *   resolveIssuerTrustState         (issuer identity via receiver-owned
 *                                    trust authority, never the body)
 *   evaluateBoundedVerification     (is the signature evidence acceptable?)
 *   writeRuntimePackage             (build the bounded package object)
 *   appendAuditEvent                (persist through the V4 audit family)
 *
 * Authority boundary: a package is admitted only when its issuer identity is
 * resolved through the receiver's own trust authority. `verified` is a
 * signature status, not trust — a verified package from an untrusted issuer
 * is rejected, and a rejection carries no durable trace of the package body.
 *
 * The trusted-key authority is dependency-injected as `trustedKeyResolver`:
 * the route must never assemble, cache, or invent issuer records itself,
 * and the records must never travel through the request body.
 */
const { writeApiError, writeJson } = require('../server-response-helpers');
const { hasSecretLookingValue } = require('../tool-call-gate');
const { validateSharedTrustPackage } = require('../../schemas/v5/shared-trust-package-validator');

const ROUTE_PATH = '/api/v5/packages';

// Chain seam references. Kept as a single module-level lookup object so the
// atomicity tests can interpose individual seams (e.g. make the audit
// append throw) without touching lib/audit-log, lib/v5/runtime-writer, or
// the schema — those modules' internals stay pinned by their own tests.
const V5_CHAIN = {
  appendAuditEvent: (...args) => require('../audit-log').appendAuditEvent(...args),
  evaluateBoundedVerification: (...args) => require('../v5/verification-core').evaluateBoundedVerification(...args),
  writeRuntimePackage: (...args) => require('../v5/runtime-writer').writeRuntimePackage(...args),
  resolveTrustedKeyState: (...args) => require('../v5/trusted-key-resolver').resolveTrustedKeyState(...args),
};

// Unit-of-work type name. The atomicity contract (docs/v5/
// v5-package-atomicity-contract.md) keys off this constant so that future
// seams (transactional outbox, a real mutation seam) inherit the same
// invariant vocabulary instead of per-seam vocabulary.
const UNIT_OF_WORK_TYPE = 'v5-package-import';

function createV5PackageImportRoute({ parseJsonRequest, trustedKeyResolver, auditTarget }) {
  if (typeof parseJsonRequest !== 'function') {
    throw new TypeError('v5-package-import route requires parseJsonRequest');
  }
  if (typeof trustedKeyResolver !== 'function') {
    throw new TypeError('v5-package-import route requires trustedKeyResolver');
  }
  if (!auditTarget || typeof auditTarget.appendAuditEvent !== 'function') {
    throw new TypeError('v5-package-import route requires an auditTarget with an appendAuditEvent method');
  }

  async function handleV5PackageImportRoute(req, res, reqUrl) {
    if (reqUrl.pathname !== ROUTE_PATH) return false;
    if (req.method !== 'POST') {
      writeApiError(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }

    let body;
    try {
      body = await parseJsonRequest(req, res, { maxBytes: 65_536 });
    } catch (_) {
      // parseJsonRequest already answered the request.
      return true;
    }
    if (body === undefined || body === null) return true;

    const schemaCheck = validateSharedTrustPackage(body);
    if (!schemaCheck.valid) {
      reject(req, res, 'INVALID_PACKAGE_SCHEMA', 'Package does not satisfy the Shared Trust Package schema.', {
        schemaErrors: schemaCheck.errors.slice(0, 5),
      });
      return true;
    }

    // Optional `receipt.sourceSnapshot` — immutable source binding, same
    // fail-closed chain as the schema check. Carried exactly as supplied:
    // the route never re-hashes, re-versions, or "fixes up" the snapshot.
    // It may not contain agent identities, trust roots, or key material;
    // secret-looking values are rejected whole at write time, matching the
    // receipt plane's `hasSecretLookingValue` semantics. Contract:
    // docs/v5/v5-immutable-source-snapshot-contract.md (§2).
    const sourceSnapshot = body.receipt && body.receipt.sourceSnapshot;
    if (sourceSnapshot !== undefined) {
      if (hasSecretLookingValue(sourceSnapshot)) {
        reject(req, res, 'INVALID_SOURCE_SNAPSHOT', 'The source snapshot carries secret-looking material and is rejected whole.', {
          snapshotRejected: true,
        });
        return true;
      }
    }

    const issuer = body.issuer;
    const trustState = trustedKeyResolver(issuer.agentId);
    if (trustState.keyState !== 'active') {
      reject(req, res, 'UNTRUSTED_ISSUER', 'Issuer identity is not resolved through the receiver trust authority.', {
        keyReference: issuer.agentId,
        keyState: trustState.keyState,
      });
      return true;
    }

    const verification = V5_CHAIN.evaluateBoundedVerification(body.evidence || {});
    if (verification.verificationStatus !== 'verified') {
      reject(req, res, 'VERIFICATION_FAILED', 'Bounded verification rejected the signature evidence.', {
        verificationStatus: verification.verificationStatus,
        reasonCategory: verification.reasonCategory,
      });
      return true;
    }

    const written = V5_CHAIN.writeRuntimePackage(body);
    if (!written || written.ok !== true) {
      reject(req, res, 'PACKAGE_WRITE_REJECTED', 'Runtime writer rejected the package input.', {
        reasonCategory: written && written.reason_category ? written.reason_category : 'writer_rejected',
        verdict: written && written.verdict ? written.verdict : '',
      });
      return true;
    }

    const auditEvent = {
      eventType: 'v5_package_imported',
      targetType: 'shared-trust-package',
      targetId: body.packageId,
      actor: 'v5-package-import-route',
      sourceRef: ROUTE_PATH,
      timestamp: new Date().toISOString(),
      details: {
        packageId: body.packageId,
        verdict: written.verdict,
        reasonCategory: written.reason_category,
        verificationStatus: verification.verificationStatus,
        issuerKeyReference: issuer.agentId,
        issuerKeyActive: true,
      },
    };
    // Atomicity: the package record is observable only together with its
    // `v5_package_imported` audit event — write-then-audit ordering, and
    // the 200 response is written only when the event is durably appended
    // (docs/v5/v5-package-atomicity-contract.md, §2).
    let committedEvent;
    try {
      committedEvent = V5_CHAIN.appendAuditEvent(auditTarget, auditEvent);
    } catch (_) {
      writeApiError(req, res, 500, 'PACKAGE_IMPORT_INCOMPLETE', 'The package record was not committed atomically with its audit event.', {
        unitOfWorkType: UNIT_OF_WORK_TYPE,
        packageId: body.packageId,
      });
      return true;
    }
    if (!committedEvent) {
      writeApiError(req, res, 500, 'PACKAGE_IMPORT_INCOMPLETE', 'The package record was not committed atomically with its audit event.', {
        unitOfWorkType: UNIT_OF_WORK_TYPE,
        packageId: body.packageId,
      });
      return true;
    }

    writeJson(req, res, 200, {
      ok: true,
      verdict: written.verdict,
      reasonCategory: written.reason_category,
      package: written.package,
    });
    return true;
  }

  return handleV5PackageImportRoute;
}

function reject(req, res, code, message, details) {
  writeApiError(req, res, 400, code, message, details);
}

function createReceiverTrustedKeyResolver({ issuerRecords }) {
  const records = Array.isArray(issuerRecords) ? issuerRecords : [];
  return function resolveIssuerTrustState(keyReference) {
    if (typeof keyReference !== 'string' || keyReference === '') {
      return { keyState: 'unknown', keyReference: null };
    }
    return V5_CHAIN.resolveTrustedKeyState({
      keyReference,
      records,
      evaluationTime: new Date().toISOString(),
    });
  };
}

module.exports = { createV5PackageImportRoute, createReceiverTrustedKeyResolver, UNIT_OF_WORK_TYPE, V5_CHAIN };
