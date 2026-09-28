'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const PRIVATE_MODE = 0o600;
const COPY_BUFFER_BYTES = 64 * 1024;

function openSiblingStagingFile(targetPath, mode = PRIVATE_MODE) {
  const directory = path.dirname(targetPath);
  const basename = path.basename(targetPath);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const stagingPath = path.join(
      directory,
      `.${basename}.${process.pid}.${crypto.randomBytes(12).toString('hex')}.tmp`,
    );
    try {
      return { descriptor: fs.openSync(stagingPath, 'wx', mode), stagingPath };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
  }
  const error = new Error(`unable to create private staging file beside ${targetPath}`);
  error.code = 'HUQAN_SECURE_STAGING_COLLISION';
  throw error;
}

function closeQuietly(descriptor) {
  if (descriptor === undefined) return;
  try { fs.closeSync(descriptor); } catch (_) { /* best-effort cleanup */ }
}

function removeQuietly(filePath) {
  if (!filePath) return;
  try { fs.rmSync(filePath, { force: true }); } catch (_) { /* best-effort cleanup */ }
}

function atomicWriteFileSync(targetPath, content, options = {}) {
  const encoding = options.encoding || 'utf8';
  const sync = options.fsync === true;
  const opened = openSiblingStagingFile(targetPath, PRIVATE_MODE);
  let descriptor = opened.descriptor;
  let stagingPath = opened.stagingPath;
  try {
    if (Buffer.isBuffer(content) || ArrayBuffer.isView(content)) fs.writeFileSync(descriptor, content);
    else fs.writeFileSync(descriptor, content, { encoding });
    if (sync) fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(stagingPath, targetPath);
    stagingPath = null;
  } finally {
    closeQuietly(descriptor);
    removeQuietly(stagingPath);
  }
}

function atomicCopyFileSync(sourcePath, targetPath, options = {}) {
  const source = fs.openSync(sourcePath, 'r');
  const opened = openSiblingStagingFile(targetPath, PRIVATE_MODE);
  let destination = opened.descriptor;
  let stagingPath = opened.stagingPath;
  try {
    const buffer = Buffer.allocUnsafe(COPY_BUFFER_BYTES);
    let bytesRead;
    do {
      bytesRead = fs.readSync(source, buffer, 0, buffer.length, null);
      if (bytesRead > 0) fs.writeSync(destination, buffer, 0, bytesRead);
    } while (bytesRead > 0);
    if (options.fsync === true) fs.fsyncSync(destination);
    fs.closeSync(destination);
    destination = undefined;
    fs.renameSync(stagingPath, targetPath);
    stagingPath = null;
  } finally {
    closeQuietly(destination);
    closeQuietly(source);
    removeQuietly(stagingPath);
  }
}

function probeWritablePathSync(targetPath, kind = 'file') {
  const directory = kind === 'dir' ? targetPath : path.dirname(targetPath);
  fs.mkdirSync(directory, { recursive: true });
  const probePath = path.join(
    directory,
    `.huqan-write-probe-${process.pid}-${crypto.randomBytes(12).toString('hex')}`,
  );
  let descriptor;
  try {
    descriptor = fs.openSync(probePath, 'wx', PRIVATE_MODE);
    fs.writeFileSync(descriptor, 'ok', 'utf8');
  } finally {
    closeQuietly(descriptor);
    removeQuietly(probePath);
  }
  return true;
}

module.exports = {
  PRIVATE_MODE,
  atomicCopyFileSync,
  atomicWriteFileSync,
  openSiblingStagingFile,
  probeWritablePathSync,
};
