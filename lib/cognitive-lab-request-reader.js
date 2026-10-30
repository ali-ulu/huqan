'use strict';

/**
 * Bounded JSON request reader for the cognitive-lab CLI (#4068, COG-M5 G2).
 *
 * The lab's store-free measurement sub-paths (`b4`, `b4-cost`, `b6`,
 * `contradiction`, ...) each read one frozen request file before any store
 * exists. A missing, oversized, symlinked or non-object file must fail here, so
 * a corrupt request never reaches a runner and no Graph -- temp or otherwise --
 * is opened for it. This lived inline in `lib/cognitive-lab-cli.js`; it is a
 * module of its own so the CLI stays under the file-size ratchet and the
 * bounded-read rule has one home.
 *
 * @module cognitive-lab-request-reader
 */

const fs = require('node:fs');

const MAX_INPUT_BYTES = 1024 * 1024;

/**
 * Read and parse a frozen request file, refusing anything but a bounded
 * regular file. The descriptor is opened with `O_NOFOLLOW` so a symlink cannot
 * redirect the read, and the same inode is validated and read, so a pathname
 * swapped mid-read cannot change what is parsed.
 *
 * @param {string} manifestPath - Path to the request file
 * @returns {object} The parsed JSON object
 * @throws {TypeError} If the file is missing, not a bounded regular file, or not a JSON object
 */
function readReplayRequest(manifestPath) {
  let descriptor;
  try {
    descriptor = fs.openSync(manifestPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch {
    throw new TypeError('replay manifest file does not exist');
  }
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_INPUT_BYTES) {
      throw new TypeError('replay manifest must be a bounded regular file');
    }
    // Validate and read the same inode, even if its pathname is replaced.
    // A single readSync may return short, so read until EOF or one byte past
    // the limit -- that extra byte proves the file outgrew the bound.
    const buffer = Buffer.alloc(MAX_INPUT_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const read = fs.readSync(descriptor, buffer, size, buffer.length - size, size);
      if (read === 0) break;
      size += read;
    }
    if (size > MAX_INPUT_BYTES) throw new TypeError('replay manifest must be a bounded regular file');
    const request = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    if (!request || typeof request !== 'object' || Array.isArray(request)) throw new TypeError('replay manifest JSON object required');
    return request;
  } finally { fs.closeSync(descriptor); }
}

module.exports = { MAX_INPUT_BYTES, readReplayRequest };
