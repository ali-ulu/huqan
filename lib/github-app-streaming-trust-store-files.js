'use strict';

// #2225: Streaming Trust store filesystem layer extracted from
// github-app-streaming-trust-store.js. One job: root/directory creation and
// bounded exclusive JSON record IO. No record-shape validation (that is
// store-records.js), no store state machine.

const fs = require('node:fs');
const path = require('node:path');
const { isPlainObject } = require('./is-plain-object');
const {
  ERROR_CODES,
  GitHubAppStreamingStoreError,
  fail,
} = require('./github-app-streaming-trust-store-records');

const MAX_RECORD_BYTES = 96 * 1024;

function assertRoot(rootPath) {
  if (typeof rootPath !== 'string' || !path.isAbsolute(rootPath) || rootPath.includes('\0')) {
    fail(ERROR_CODES.INVALID_ROOT, 'Streaming Trust store path must be absolute');
  }
  const root = path.resolve(rootPath);
  try {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(ERROR_CODES.INVALID_ROOT, 'Streaming Trust store root must be a real directory');
    }
  } catch (error) {
    if (error instanceof GitHubAppStreamingStoreError) throw error;
    fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store root could not be created');
  }
  return root;
}

function ensureDirectory(directory) {
  try {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      fail(ERROR_CODES.INVALID_ROOT, 'Streaming Trust store directory must be a real directory');
    }
  } catch (error) {
    if (error instanceof GitHubAppStreamingStoreError) throw error;
    fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store directory could not be created');
  }
}

function writeExclusiveJson(filePath, value) {
  const text = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_RECORD_BYTES) {
    fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store record exceeds its size bound');
  }
  let fd;
  try {
    fd = fs.openSync(filePath, 'wx', 0o600);
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    return true;
  } catch (error) {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) { /* no-op */ }
    }
    if (error && error.code === 'EEXIST') return false;
    fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store write failed');
  }
}

// #4087 PR-4: the public receipt route is given a publicReceiptId, not the
// delivery id its record is filed under, so it must locate the record by
// scanning. The scan is bounded by entry count and returns only `.json` names,
// sorted, so a directory that has grown past the bound is a refusal rather than
// an unbounded read.
// shortcut: the read route refuses to scan past this many records, so a store
// that holds more public receipts than this answers "not found" for the
// overflow; upgrade to a publicReceiptId -> deliveryId index when a deployment
// actually files more than a few hundred receipts.
const MAX_DIRECTORY_ENTRIES = 512;

function listRecordFileNames(directory, maxEntries = MAX_DIRECTORY_ENTRIES) {
  let names;
  try {
    names = fs.readdirSync(directory);
  } catch (error) {
    if (error && error.code === 'ENOENT') return [];
    fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store directory could not be read');
  }
  if (!Array.isArray(names)) fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store directory could not be read');
  const records = names.filter((name) => name.endsWith('.json')).sort();
  if (records.length > maxEntries) {
    fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store directory exceeds its entry bound');
  }
  return records;
}

function readJsonFile(filePath) {
  let stat;
  try {
    stat = fs.lstatSync(filePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store record could not be inspected');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > MAX_RECORD_BYTES) {
    fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store record is invalid');
  }
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!isPlainObject(value)) fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store record is invalid');
    return value;
  } catch (error) {
    if (error instanceof GitHubAppStreamingStoreError) throw error;
    fail(ERROR_CODES.IO_FAILED, 'Streaming Trust store record could not be read');
  }
}

module.exports = {
  MAX_RECORD_BYTES,
  MAX_DIRECTORY_ENTRIES,
  assertRoot,
  ensureDirectory,
  writeExclusiveJson,
  listRecordFileNames,
  readJsonFile,
};
