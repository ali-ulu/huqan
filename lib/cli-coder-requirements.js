'use strict';
const fs = require('node:fs');
const { TextDecoder } = require('node:util');
function refused(message) {
  const error = new Error(message); error.exitCode = 5; return error;
}
function readRequirements(file, { parseRequirements, maxBytes } = {}) {
  if (typeof parseRequirements !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw refused('REQUIREMENTS_READER_UNAVAILABLE');
  let descriptor;
  try {
    descriptor = fs.openSync(file, 'r');
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw refused('REQUIREMENTS_FILE_INVALID');
    if (stat.size > maxBytes) throw refused('REQUIREMENTS_OVER_CAP');
    const bytes = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = fs.readSync(descriptor, bytes, length, bytes.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length > maxBytes) throw refused('REQUIREMENTS_OVER_CAP');
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)); }
    catch { throw refused('REQUIREMENTS_UTF8_INVALID'); }
    const parsed = parseRequirements(text);
    if (!parsed.ok) throw refused(`${parsed.reason} at line ${parsed.line}`);
    return parsed.spec;
  } catch (error) {
    if (error.exitCode === 5) throw error;
    throw refused(`REQUIREMENTS_FILE_UNAVAILABLE: ${error.code || 'READ_FAILED'}`);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}
module.exports = { readRequirements };
