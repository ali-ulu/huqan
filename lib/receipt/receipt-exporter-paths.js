'use strict';

// Output-target selection and JSON writing for plugins/receipt-exporter.js
// (#2199). Kept in lib/ rather than beside the plugin: the plugin manifest
// hashes only the plugin file, so a helper under plugins/ would look like
// signed plugin code without being covered by that hash.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { canonicalizePath, createPathError, isPathWithinRoot, resolvePathWithinRoot, withRealpathSpellings } = require('../path-safety');
const { resolveReceiptsDir } = require('../../persistencePaths');

const REPO_ROOT = path.join(__dirname, '..', '..');
// Dev fallback only: the repo checkout's own receipts/ stays a valid explicit
// target, but it is no longer the default -- a read-only install cannot be
// written to (H-09, #1982).
const DEV_RECEIPTS_ROOT = path.join(REPO_ROOT, 'receipts');
// User-data default, resolved lazily per call (see defaultOutputDir): the
// install dir is never written unless the caller explicitly asks for it.
const DEFAULT_OUTPUT_DIR = resolveReceiptsDir();

function defaultOutputDir(environment = process.env) {
  return resolveReceiptsDir(environment);
}

/**
 * Pick the enforcement boundary for a caller-supplied output dir.
 *
 * Repo-contained paths stay bounded to receipts/ exactly as before (#1280):
 * outputDir '<repo>' plus receiptId 'package' must never reach
 * '<repo>/package.json'. Anything outside the repo is a user-data-style
 * target and is accepted under the longest matching root of the default
 * receipts dir, the OS temp dir, or the working directory -- so tmp/cwd
 * exports work on a read-only install. Anything else fails closed.
 */
function resolveExportRoot(candidateDir) {
  const absolute = path.resolve(candidateDir);
  if (isPathWithinRoot(REPO_ROOT, absolute)) {
    return DEV_RECEIPTS_ROOT;
  }
  const roots = withRealpathSpellings([defaultOutputDir(), os.tmpdir(), process.cwd()])
    .filter((root) => isPathWithinRoot(root, absolute))
    .sort((left, right) => right.length - left.length);
  if (!roots.length) {
    throw createPathError(
      'PATH_OUTSIDE_ALLOWED_ROOT',
      'Path escapes allowed root',
      defaultOutputDir(),
      absolute,
    );
  }
  return roots[0];
}

// The receiptId doubles as the output file name, so it is constrained to a
// single safe path segment. Real receipt ids are already generated from this
// alphabet (`apr_receipt_<hash>`, `madm_receipt_<sha1>`,
// `external_candidate_receipt_<sha256>`), so this rejects attacker-shaped
// input without narrowing any legitimate id.
const MAX_RECEIPT_ID_LEN = 128;
const SAFE_RECEIPT_ID = /^[A-Za-z0-9._-]+$/;

/**
 * Resolve the file-name stem for a receipt, fail-closed (#543).
 *
 * `outputDir` is bounded to an export root (repo paths to receipts/, others
 * to the user-data/tmp/cwd boundary), but the file name was previously
 * interpolated straight from `receipt.receiptId || receipt.id`, so a value like
 * `../package` escaped the receipts/ directory and overwrote unrelated repo
 * files. The id is now required to be a single safe path segment; a missing id
 * still falls back to a generated one, but a *present but unsafe* id is an
 * error rather than something quietly rewritten to a different target.
 */
function resolveReceiptFileStem(receipt) {
  const raw = receipt.receiptId || receipt.id;
  if (raw === undefined || raw === null || raw === '') {
    return `receipt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  const candidate = String(raw).trim();
  const isSafeSegment = Boolean(candidate)
    && candidate.length <= MAX_RECEIPT_ID_LEN
    && SAFE_RECEIPT_ID.test(candidate)
    // `.` and `..` match the alphabet above but are directory references.
    && !/^\.+$/.test(candidate);

  if (!isSafeSegment) {
    throw createPathError(
      'RECEIPT_EXPORT_INVALID_RECEIPT_ID',
      'receiptId is not a safe file name segment',
      DEV_RECEIPTS_ROOT,
      candidate,
    );
  }
  return candidate;
}

/**
 * Resolve the output directory and the final file path together, so the
 * boundary is enforced against the path actually written -- not just
 * against the directory it was meant to land in.
 */
function resolveReceiptTarget(receipt, outputDir, extension) {
  const exportRoot = resolveExportRoot(outputDir || defaultOutputDir());
  const resolvedDir = resolvePathWithinRoot(exportRoot, outputDir || defaultOutputDir(), { allowMissing: true });
  const stem = resolveReceiptFileStem(receipt);
  const filePath = path.join(resolvedDir, `${stem}.${extension}`);

  // Defence in depth: the stem is already a validated single segment, so this
  // should be unreachable; compare canonical spellings (canonicalizePath
  // covers not-yet-created roots via the longest existing ancestor).
  if (path.dirname(filePath) !== resolvedDir || !isPathWithinRoot(canonicalizePath(exportRoot, true), filePath)) {
    throw createPathError(
      'PATH_OUTSIDE_ALLOWED_ROOT',
      'Path escapes allowed root',
      exportRoot,
      filePath,
    );
  }

  fs.mkdirSync(resolvedDir, { recursive: true });
  return filePath;
}

// Exclusive create ('wx'): receipts are immutable evidence, so a second
// export attempt for the same target must fail rather than silently
// overwrite what may be a different receipt that happened to resolve to the
// same file name (#1280). Mirrors lib/v5/public-trust-receipt.js's own
// exclusive-write pattern.
function writeExclusive(filePath, bytes, exportRoot) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'wx');
  } catch (error) {
    if (error && error.code === 'EEXIST') {
      throw createPathError('RECEIPT_EXPORT_TARGET_EXISTS', 'receipt export target already exists', exportRoot || DEV_RECEIPTS_ROOT, filePath);
    }
    throw error;
  }
  try {
    fs.writeSync(fd, bytes);
  } finally {
    fs.closeSync(fd);
  }
}

function exportReceiptToFile(receipt, outputDir) {
  const filePath = resolveReceiptTarget(receipt, outputDir, 'json');
  writeExclusive(filePath, JSON.stringify(receipt, null, 2), resolveExportRoot(outputDir || defaultOutputDir()));
  return filePath;
}

module.exports = { defaultOutputDir, resolveExportRoot, resolveReceiptFileStem, resolveReceiptTarget, exportReceiptToFile, DEFAULT_OUTPUT_DIR, DEV_RECEIPTS_ROOT };
