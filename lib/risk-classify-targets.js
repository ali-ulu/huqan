"use strict";

// Path and URL matchers for lib/risk-classify.js (#2120): allowlist membership
// and the security-sensitive path check. Pure functions, no I/O.
const path = require('path');
const { SECURITY_SENSITIVE_PATH_TOKENS } = require('./risk-policy-constants');
const { toArray } = require('./risk-classify-normalize');

function normalizePath(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const slashed = value.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
  if (!slashed) {
    return '';
  }
  // Collapse `..`/`.` segments so an allowlist prefix check (startsWith) can't
  // be bypassed with e.g. `/home/user/../../etc/passwd` (#375).
  const normalized = path.posix.normalize(slashed);
  return normalized === '.' ? '' : normalized;
}
function parseUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = new URL(value.trim());
    if (/%2f|%5c/i.test(parsed.pathname)) return null;
    return parsed;
  } catch (_) {
    return null;
  }
}

function isPathInList(path, allowlistedPaths) {
  const normalizedPath = normalizePath(path);
  const list = toArray(allowlistedPaths).map(normalizePath).filter(Boolean);
  if (!normalizedPath || list.length === 0) {
    return false;
  }
  return list.some((allowed) => normalizedPath === allowed || normalizedPath.startsWith(allowed.endsWith('/') ? allowed : `${allowed}/`));
}

function isUrlInList(url, allowlistedUrls) {
  const target = parseUrl(url);
  const list = toArray(allowlistedUrls).map(parseUrl).filter(Boolean);
  if (!target || list.length === 0) {
    return false;
  }
  return list.some((allowed) => {
    if (target.protocol !== allowed.protocol || target.host !== allowed.host) return false;
    return target.pathname === allowed.pathname
      || target.pathname.startsWith(allowed.pathname.endsWith('/') ? allowed.pathname : `${allowed.pathname}/`);
  });
}

function isPathSecuritySensitive(path) {
  const normalizedPath = normalizePath(path);
  if (!normalizedPath) {
    return false;
  }
  // Case-insensitive match: Windows and macOS file systems are case-insensitive,
  // so Kernel.JS / KERNEL.JS must match tokens defined as kernel.js.
  const loweredPath = normalizedPath.toLowerCase();
  // #1286: a bare `endsWith(token)` treats any file whose name merely ends
  // with a token as a match ('mykernel.js' ends with 'kernel.js',
  // 'notpackage.json' ends with 'package.json'), over-blocking legitimate
  // paths. Likewise `includes('/' + token)` matched the token anywhere in
  // the path with no right-hand boundary, so 'lib/verify.js.bak' matched
  // token 'lib/verify.js' too. Require either an exact bare-name match or a
  // '/'-preceded suffix match, which correctly handles both single-segment
  // tokens ('kernel.js') and multi-segment ones ('lib/verify.js') while
  // requiring the token to end the path, not merely appear as a substring.
  return SECURITY_SENSITIVE_PATH_TOKENS.some((token) => {
    const loweredToken = normalizePath(token).toLowerCase();
    return loweredPath === loweredToken || loweredPath.endsWith(`/${loweredToken}`);
  });
}

module.exports = {
  isPathInList,
  isUrlInList,
  isPathSecuritySensitive,
};
