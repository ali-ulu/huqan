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
 */

const fs = require('node:fs');
const path = require('node:path');

const { sha256Hex } = require('../hash-chain');
const {
  EVIDENCE_PACK_SCHEMA_VERSION,
  INTEGRITY_CLASS_VALUES,
  computePackHash,
} = require('./manifest');
const { verifyExportedBundle } = require('../receipt/receipt-export');

const MANIFEST_FILE = 'manifest.json';
const SIGNATURE_FILE = 'manifest.signature.json';
const BUNDLE_RELATIVE_PATH = 'receipts/receipt-bundle.json';

function readManifest(packDir) {
  const manifestPath = path.join(packDir, MANIFEST_FILE);
  let text;
  try {
    text = fs.readFileSync(manifestPath, 'utf8');
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
 * @param {string} packDir
 * @returns {{valid: boolean, findings: string[], files: Array<{path: string, integrityClass: string|null, present: boolean, hashValid: boolean|null}>, nonClaims: string[]}}
 */
function verifyPack(packDir) {
  const findings = [];
  const { manifest, findings: readFindings } = readManifest(packDir);
  if (readFindings.length > 0) {
    return { valid: false, findings: readFindings, files: [], nonClaims: [] };
  }

  findings.push(...validateManifestShape(manifest));
  if (findings.includes('manifest_not_object') || findings.includes('manifest_files_missing')) {
    const nonClaims = manifest && Array.isArray(manifest.nonClaims) ? manifest.nonClaims : [];
    return { valid: false, findings, files: [], nonClaims };
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
    const absolute = path.join(packDir, relative);
    let bytes;
    try {
      bytes = fs.readFileSync(absolute);
    } catch {
      findings.push(`missing_file:${relative}`);
      files.push({ path: relative, integrityClass: entry.integrityClass || null, present: false, hashValid: null });
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
      const bundle = JSON.parse(fs.readFileSync(path.join(packDir, BUNDLE_RELATIVE_PATH), 'utf8'));
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

  return {
    valid: findings.length === 0,
    findings,
    files,
    nonClaims: Array.isArray(manifest.nonClaims) ? manifest.nonClaims : [],
  };
}

module.exports = {
  MANIFEST_FILE,
  SIGNATURE_FILE,
  BUNDLE_RELATIVE_PATH,
  readManifest,
  validateManifestShape,
  listPackFiles,
  verifyPack,
};
