'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

/**
 * The executables package.json ships as `bin` (#2401). They are product code a
 * consumer runs, so they are measured with the product bands; any other file
 * under bin/ stays tooling. Derived from package.json, not listed here, so a
 * bin added or dropped there moves in or out of product scope by itself.
 */
function packagedBins(pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'))) {
  const bin = typeof pkg.bin === 'string' ? { [pkg.name]: pkg.bin } : (pkg.bin || {});
  return new Set(Object.values(bin).map((entry) => path.posix.normalize(String(entry)).replace(/^\.\//, '')));
}

const PACKAGED_BINS = packagedBins();

const isProduct = (file, bins = PACKAGED_BINS) => bins.has(file) || (!file.startsWith('scripts/')
  && !file.startsWith('examples/')
  && !file.startsWith('bin/'));

module.exports = { isProduct, packagedBins };
