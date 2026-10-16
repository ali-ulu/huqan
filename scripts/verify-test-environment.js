'use strict';

/**
 * Fail-fast test environment contract.
 *
 * `npm test` on an unsupported Node version or without its native/optional
 * dependencies produces hundreds of secondary failures that hide the single
 * root cause. This module checks the root causes first and reports exactly
 * one actionable error instead.
 *
 * Checks:
 *   1. Node >= 22.13.0 (package.json engines).
 *   2. better-sqlite3 loads (required native dependency).
 *   3. pdfjs-dist resolves (optional dependency; PDF tests need it).
 */

const MIN_NODE = '22.13.0';

function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

function checkNodeVersion(version = process.version) {
  const clean = version.replace(/^v/, '');
  if (compareVersions(clean, MIN_NODE) < 0) {
    return `unsupported Node ${version}: HUQAN requires Node >= ${MIN_NODE}. Run: nvm use 22.13.0 (see .nvmrc)`;
  }
  return null;
}

function checkNativeBinding() {
  try {
    require('better-sqlite3');
    return null;
  } catch (error) {
    return `better-sqlite3 native binding missing (${error.message}). Run: npm ci`;
  }
}

function checkOptionalPdf() {
  try {
    require.resolve('pdfjs-dist');
    return null;
  } catch {
    return 'optional dependency pdfjs-dist not installed: PDF tests will fail. Run: npm ci --include=optional';
  }
}

function verifyTestEnvironment(opts = {}) {
  const errors = [];
  const nodeError = checkNodeVersion(opts.nodeVersion);
  if (nodeError) errors.push(nodeError);
  if (opts.checkNative !== false) {
    const nativeError = checkNativeBinding();
    if (nativeError) errors.push(nativeError);
  }
  if (opts.checkOptionalPdf !== false) {
    const pdfError = checkOptionalPdf();
    if (pdfError) errors.push(pdfError);
  }
  return errors;
}

module.exports = { verifyTestEnvironment, checkNodeVersion, checkNativeBinding, checkOptionalPdf, MIN_NODE };

if (require.main === module) {
  const errors = verifyTestEnvironment();
  if (errors.length > 0) {
    for (const error of errors) process.stderr.write(`test environment: ${error}\n`);
    process.exit(1);
  }
  process.stdout.write(`test environment OK (Node ${process.version})\n`);
}
