// SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise
'use strict';

/**
 * Independent evidence-pack verification (#4092, PR-A1).
 *
 * `verifyPack` reads a pack directory and decides whether it is internally
 * consistent: the manifest recomputes to its own `packHash`, every listed file
 * is present with the recorded bytes, no unlisted file is hiding in the
 * directory, and the receipt bundle -- when the pack carries one -- passes the
 * same bundle checks a third-party verifier runs.
 *
 * It takes only the directory. It shares no state with whatever produced the
 * pack, which is the point: a verifier that needed the producer's process could
 * not be handed to an auditor. The receipt bundle is checked through
 * `verifyExportedBundle`, the module that already owns that contract, rather
 * than a second copy of the bundle rules.
 *
 * The verdict is per-file as well as whole-pack. A reader needs to know which
 * files are merely hash-listed and which rest on a chain, so `integrityClass`
 * travels with each result and the pack's `nonClaims` are reported back rather
 * than assumed read.
 *
 * Every byte is read through `readFileWithinRoot` (#4247, CWE-22): a manifest
 * names a path, and a path is a claim the pack can lie about. A symlink, a
 * FIFO or a device where the manifest promised a regular file is refused
 * fail-closed (`unsafe_file:<path>`) instead of being hashed or opened, so a
 * link cannot smuggle in outside bytes and a FIFO cannot block the verifier.
 */

const fs = require('node:fs');
const path = require('node:path');

const { sha256Hex } = require('../hash-chain');
const { readFileWithinRoot } = require('../path-safety');
const {
  EVIDENCE_PACK_SCHEMA_VERSION,
  INTEGRITY_CLASS_VALUES,
  computePackHash,
} = require('./manifest');
const { SIGNATURE_NON_CLAIM, verifyPackSignature } = require('./signature');
const { verifyExportedBundle } = require('../receipt/receipt-export');
const { verifyLedgerEntries } = require('../emergency-stop-chain');
const { readTrustedBatchKeys } = require('../external-action-receipt-collector-store');
const { COLLECTOR_NON_CLAIM, COLLECTOR_SEALS_RELATIVE_PATH, checkCollectorSeals } = require('./collector-seals');

const MANIFEST_FILE = 'manifest.json';
const SIGNATURE_FILE = 'manifest.signature.json';
const BUNDLE_RELATIVE_PATH = 'receipts/receipt-bundle.json';
const LEDGER_RELATIVE_PATH = 'emergency-stop/ledger.jsonl';

/**
 * Read a path as a regular file inside the pack, or report why it is refused.
 * `PATH_NOT_FOUND` is the only "it is simply not there"; every other code is a
 * path the pack handed over as something other than the file it claimed.
 */
function readListedFile(packDir, relative) {
  try {
    return { bytes: readFileWithinRoot(packDir, relative) };
  } catch (error) {
    return { error };
  }
}

function readManifest(packDir) {
  let text;
  try {
    text = readFileWithinRoot(packDir, MANIFEST_FILE).toString('utf8');
  } catch {
    return { manifest: null, findings: ['manifest_unreadable'] };
  }
  try {
    return { manifest: JSON.parse(text), findings: [] };
  } catch {
    return { manifest: null, findings: ['manifest_not_json'] };
  }
}

function validateManifestShape(manifest) {
  const findings = [];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    return ['manifest_not_object'];
  }
  if (manifest.schemaVersion !== EVIDENCE_PACK_SCHEMA_VERSION) {
    findings.push('manifest_schema_version_mismatch');
  }
  if (!Array.isArray(manifest.files)) {
    findings.push('manifest_files_missing');
  }
  return findings;
}

/**
 * The manifest path policy: a packed file is named by a canonical, relative,
 * forward-slash path. An absolute path, a backslash, a `.` or `..` segment, or a
 * non-normalized form would let `path.join(packDir, ...)` resolve outside the
 * pack, so it is rejected before any file is opened. Same rule, same token, in
 * `verify_pack.py`.
 */
function manifestPathInvalid(relative) {
  if (path.posix.isAbsolute(relative) || path.isAbsolute(relative)) return true;
  if (relative.includes('\\')) return true;
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return true;
  return path.posix.normalize(relative) !== relative;
}

/**
 * Walk every regular file under `packDir`, in a stable order, as paths relative
 * to the pack root. Symlinked directories are not followed: a pack is a set of
 * bytes, and a link out of the directory is a file that is not in the pack. A
 * symlink that is not a directory is still pushed, so it is reported as an
 * unlisted file rather than silently skipped.
 */
function listPackFiles(packDir) {
  const out = [];
  const visit = (absolute, relative) => {
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const childAbsolute = path.join(absolute, entry.name);
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) visit(childAbsolute, childRelative);
      else out.push(childRelative);
    }
  };
  visit(packDir, '');
  return out;
}

/**
 * Parse the ledger as the ledger itself reads it, except that a line which is
 * not a JSON object is a corrupt entry, never skipped, so verifyLedgerEntries
 * refuses it.
 */
function parseLedgerEntries(text) {
  const entries = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed);
      entries.push(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { __corrupt: true });
    } catch {
      entries.push({ __corrupt: true });
    }
  }
  return entries;
}

/**
 * The optional manifest signature. A manifest that names an issuer key but ships
 * no signature file is a stripped signature, not an unsigned pack.
 * @returns {{signed: boolean, keyId: string|null}}
 */
function checkSignature(packDir, manifest, findings) {
  const declared = manifest.producer?.issuerKeyId ?? null;
  let text;
  try {
    text = readFileWithinRoot(packDir, SIGNATURE_FILE).toString('utf8');
  } catch (error) {
    if (error.code === 'PATH_NOT_FOUND') {
      if (declared) findings.push('signature_missing');
      return { signed: false, keyId: null };
    }
    findings.push('signature_unreadable');
    return { signed: true, keyId: null };
  }
  let envelope = null;
  try { envelope = JSON.parse(text); } catch { /* reported as signature_format_invalid */ }
  const result = verifyPackSignature(manifest, envelope);
  findings.push(...result.findings);
  return { signed: true, keyId: result.keyId };
}

/** The collector seal chain; keys come from the caller (a separate channel), never from the pack. */
function checkCollectorFile(packDir, manifest, collectorPubkeys, findings) {
  let text;
  try {
    text = readFileWithinRoot(packDir, COLLECTOR_SEALS_RELATIVE_PATH).toString('utf8');
  } catch {
    findings.push('collector_seals_unreadable');
    return [];
  }
  const keys = collectorPubkeys ? readTrustedBatchKeys(collectorPubkeys) : null;
  const result = checkCollectorSeals(text, keys, manifest.producer?.issuerKeyId ?? null);
  findings.push(...result.findings);
  return result.warnings;
}

/**
 * @param {string} packDir
 * @param {{collectorPubkeys?: string}} [options] collectorPubkeys: directory of collector public keys, supplied apart from the pack
 * @returns {{valid: boolean, findings: string[], files: Array<{path: string, integrityClass: string|null, present: boolean, hashValid: boolean|null}>, nonClaims: string[], warnings: string[], signature?: {signed: boolean, keyId: string|null}}}
 */
function verifyPack(packDir, options = {}) {
  const findings = [];
  const { manifest, findings: readFindings } = readManifest(packDir);
  if (readFindings.length > 0) {
    return { valid: false, findings: readFindings, files: [], nonClaims: [], warnings: [] };
  }

  findings.push(...validateManifestShape(manifest));
  if (findings.includes('manifest_not_object') || findings.includes('manifest_files_missing')) {
    const nonClaims = manifest && Array.isArray(manifest.nonClaims) ? manifest.nonClaims : [];
    return { valid: false, findings, files: [], nonClaims, warnings: [] };
  }

  if (computePackHash(manifest) !== manifest.packHash) {
    findings.push('pack_hash_mismatch');
  }

  const entries = new Map();
  const files = [];
  for (const entry of manifest.files) {
    if (!entry || typeof entry.path !== 'string' || entry.path === '') {
      findings.push('manifest_file_entry_invalid');
      continue;
    }
    if (manifestPathInvalid(entry.path)) {
      findings.push(`manifest_path_invalid:${entry.path}`);
      continue;
    }
    if (entries.has(entry.path)) findings.push(`manifest_duplicate_entry:${entry.path}`);
    entries.set(entry.path, entry);
    if (!INTEGRITY_CLASS_VALUES.includes(entry.integrityClass)) {
      findings.push(`manifest_unknown_integrity_class:${entry.path}`);
    }
  }

  for (const [relative, entry] of entries) {
    const { bytes, error } = readListedFile(packDir, relative);
    if (error) {
      if (error.code === 'PATH_NOT_FOUND') {
        findings.push(`missing_file:${relative}`);
        files.push({ path: relative, integrityClass: entry.integrityClass || null, present: false, hashValid: null });
      } else {
        // A link, a FIFO or a device where the manifest promised a regular
        // file: refuse it rather than hash whatever the path resolves to.
        findings.push(`unsafe_file:${relative}`);
        files.push({ path: relative, integrityClass: entry.integrityClass || null, present: false, hashValid: null });
      }
      continue;
    }
    const hashValid = sha256Hex(bytes) === entry.sha256;
    if (!hashValid) findings.push(`file_hash_mismatch:${relative}`);
    if (!Number.isInteger(entry.bytes) || entry.bytes !== bytes.length) {
      findings.push(`file_size_mismatch:${relative}`);
    }
    files.push({ path: relative, integrityClass: entry.integrityClass || null, present: true, hashValid });
  }

  // A file in the directory that the manifest does not list is a finding, not a
  // convenience: the manifest is the claim about what the pack contains.
  for (const relative of listPackFiles(packDir)) {
    if (relative === MANIFEST_FILE || relative === SIGNATURE_FILE) continue;
    if (!entries.has(relative)) findings.push(`unlisted_file:${relative}`);
  }

  // The bundle, when present, is checked by the module that owns the bundle
  // contract. A pack that carries one must carry a valid one (INV-A2).
  if (entries.has(BUNDLE_RELATIVE_PATH)) {
    try {
      const bundle = JSON.parse(readFileWithinRoot(packDir, BUNDLE_RELATIVE_PATH).toString('utf8'));
      // A pack check is structural: signature verification needs the issuer's
      // key resolver, which a standalone verifier does not have and the pack
      // does not ask it for. Drop any signature so a validly signed bundle is
      // not judged invalid here, matching verify_pack.py.
      const bundleForChecks = { ...bundle };
      delete bundleForChecks.bundleSignature;
      const result = verifyExportedBundle(bundleForChecks);
      if (!result.valid) findings.push('receipt_bundle_invalid');
    } catch {
      findings.push('receipt_bundle_unreadable');
    }
  }

  // The ledger is a hash chain the pack can re-walk from genesis; a resealed
  // manifest over an edited ledger is caught here, not by the file hash.
  if (entries.has(LEDGER_RELATIVE_PATH)) {
    try {
      const text = readFileWithinRoot(packDir, LEDGER_RELATIVE_PATH).toString('utf8');
      const chain = verifyLedgerEntries(parseLedgerEntries(text));
      if (!chain.ok) findings.push(`emergency_stop_ledger_invalid:${chain.reason}`);
    } catch {
      findings.push('emergency_stop_ledger_unreadable');
    }
  }

  const hasCollectorSeals = entries.has(COLLECTOR_SEALS_RELATIVE_PATH);
  const warnings = hasCollectorSeals ? checkCollectorFile(packDir, manifest, options.collectorPubkeys, findings) : [];

  const signature = checkSignature(packDir, manifest, findings);
  const nonClaims = Array.isArray(manifest.nonClaims) ? [...manifest.nonClaims] : [];
  if (signature.signed) nonClaims.push(SIGNATURE_NON_CLAIM);
  if (hasCollectorSeals) nonClaims.push(COLLECTOR_NON_CLAIM);
  return { valid: findings.length === 0, findings, files, nonClaims, warnings, signature };
}

module.exports = {
  MANIFEST_FILE,
  SIGNATURE_FILE,
  BUNDLE_RELATIVE_PATH,
  LEDGER_RELATIVE_PATH,
  readManifest,
  validateManifestShape,
  listPackFiles,
  verifyPack,
};
