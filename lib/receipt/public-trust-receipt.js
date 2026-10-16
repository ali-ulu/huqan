'use strict';

// Public Trust Receipt files: writing one next to a safely resolved parent and
// reading it back through the verifying import. The receipt itself --
// contract, values, integrity, export and import -- lives in
// public-trust-receipt-*.js (#2161).

const fs = require('node:fs');
const path = require('node:path');
const { ERROR_CODES, MAX_PUBLIC_RECEIPT_BYTES, PUBLIC_RECEIPT_SCHEMA_VERSION, PUBLIC_RECEIPT_SIGNATURE_DOMAIN, PublicTrustReceiptError, fail } = require('./public-trust-receipt-contract');
const { exportPublicTrustReceipt, toCanonicalPublicReceiptBytes } = require('./public-trust-receipt-export');
const { importPublicTrustReceipt } = require('./public-trust-receipt-import');
const { computePublicReceiptChecksum } = require('./public-trust-receipt-integrity');
const { deepFreeze } = require('./public-trust-receipt-values');

function sameResolvedPath(left, right) {
  const a = path.normalize(left);
  const b = path.normalize(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function resolveSafeParent(filePath) {
  if (typeof filePath !== 'string' || filePath.length === 0 || filePath.includes('\0')) {
    fail(ERROR_CODES.UNSAFE_PATH, 'public receipt path is invalid');
  }
  const resolved = path.resolve(filePath);
  const parent = path.dirname(resolved);
  let stat;
  let realParent;
  try {
    stat = fs.lstatSync(parent);
    realParent = fs.realpathSync(parent);
  } catch (_) {
    fail(ERROR_CODES.UNSAFE_PATH, 'public receipt parent directory is unavailable');
  }
  if (!stat.isDirectory() || stat.isSymbolicLink() || !sameResolvedPath(parent, realParent)) {
    fail(ERROR_CODES.UNSAFE_PATH, 'public receipt parent directory is not a real directory');
  }
  return resolved;
}

function writePublicTrustReceiptFile(filePath, receipt) {
  const bytes = toCanonicalPublicReceiptBytes(receipt);
  const resolved = resolveSafeParent(filePath);
  try {
    fs.lstatSync(resolved);
    fail(ERROR_CODES.TARGET_EXISTS, 'public receipt target already exists');
  } catch (error) {
    if (error instanceof PublicTrustReceiptError) throw error;
    if (error?.code !== 'ENOENT') fail(ERROR_CODES.UNSAFE_PATH, 'public receipt target is unsafe');
  }

  let descriptor;
  let created = false;
  try {
    descriptor = fs.openSync(resolved, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
    return Object.freeze({ path: resolved, bytesWritten: bytes.length });
  } catch (error) {
    if (error instanceof PublicTrustReceiptError) throw error;
    if (error?.code === 'EEXIST') {
      fail(ERROR_CODES.TARGET_EXISTS, 'public receipt target already exists');
    }
    if (created) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch (_) { /* rollback still remains best-effort */ }
        descriptor = undefined;
      }
      try { fs.unlinkSync(resolved); } catch (_) { /* best-effort rollback of our exclusive file */ }
    }
    fail(ERROR_CODES.FILE_WRITE_FAILED, 'public receipt file write failed');
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) { /* close cannot change the write verdict */ }
    }
  }
}

function readPublicTrustReceiptFile(filePath, options) {
  let descriptor;
  try {
    const resolved = resolveSafeParent(filePath);
    const noFollow = fs.constants.O_NOFOLLOW || 0;
    descriptor = fs.openSync(resolved, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(descriptor, { bigint: true });
    const stat = fs.lstatSync(resolved, { bigint: true });
    const real = fs.realpathSync(resolved);
    if (!opened.isFile()
      || !stat.isFile()
      || stat.isSymbolicLink()
      || opened.dev !== stat.dev
      || opened.ino !== stat.ino
      || !sameResolvedPath(resolved, real)) {
      fail(ERROR_CODES.UNSAFE_PATH, 'public receipt target is not a real file');
    }
    if (opened.size < 1n || opened.size > BigInt(MAX_PUBLIC_RECEIPT_BYTES)) {
      fail(ERROR_CODES.SIZE_LIMIT, 'public receipt exceeds the byte limit');
    }
    return importPublicTrustReceipt(fs.readFileSync(descriptor), options);
  } catch (error) {
    if (error instanceof PublicTrustReceiptError) {
      return deepFreeze({ ok: false, status: 'rejected', error: { code: error.code } });
    }
    if (error?.code === 'ELOOP' || error?.code === 'EMLINK') {
      return deepFreeze({
        ok: false,
        status: 'rejected',
        error: { code: ERROR_CODES.UNSAFE_PATH },
      });
    }
    return deepFreeze({
      ok: false,
      status: 'rejected',
      error: { code: ERROR_CODES.FILE_READ_FAILED },
    });
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch (_) { /* read result is already bounded */ }
    }
  }
}

module.exports = {
  ERROR_CODES,
  MAX_PUBLIC_RECEIPT_BYTES,
  PUBLIC_RECEIPT_SCHEMA_VERSION,
  PUBLIC_RECEIPT_SIGNATURE_DOMAIN,
  PublicTrustReceiptError,
  computePublicReceiptChecksum,
  exportPublicTrustReceipt,
  importPublicTrustReceipt,
  readPublicTrustReceiptFile,
  toCanonicalPublicReceiptBytes,
  writePublicTrustReceiptFile,
};
