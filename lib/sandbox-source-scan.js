'use strict';

// The lexical scans the sandbox isolation gate runs over source and intent
// text: forbidden capabilities, external network access, destructive cleanup,
// and snapshot limits (#2135).

const { normalizeText } = require('./text-utils');

const FORBIDDEN_CAPABILITY_HINTS = Object.freeze([
  'require',
  'process',
  'globalThis',
  'global',
  'module',
  'exports',
  'Function',
  'eval',
  'import(',
  'constructor',
  'child_process',
  'fs',
  'net',
  'http',
  'https',
  'dgram',
  'cluster',
  'worker_threads',
]);

const EXTERNAL_NETWORK_HINTS = Object.freeze([
  'http',
  'https',
  'fetch',
  'request',
  'websocket',
  'socket',
  'dns',
  'net.connect',
  'XMLHttpRequest',
]);

const DESTRUCTIVE_CLEANUP_HINTS = Object.freeze([
  'delete',
  'remove',
  'destroy',
  'wipe',
  'truncate',
  'erase',
  'purge',
  'cleanup',
]);

function containsAny(text, tokens) {
  const lower = normalizeText(text);
  return tokens.some(token => lower.includes(normalizeText(token)));
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Word-boundary token match (#380): plain substring matching produced both
// false positives ('eval' matching inside 'evaluation', the 2-char token
// 'fs' matching inside 'offshore') and, being purely lexical, was already
// trivially defeated by string-concatenation obfuscation ('req'+'uire').
// This does not fix the latter -- no lexical/regex scan can, only real
// runtime isolation (vm/worker + Proxy trap on the sandbox globals) can --
// but it does close the false-positive/false-negative gap around word
// boundaries, which is the part a static scan can actually get right.
// A token is only boundary-checked on a side that starts/ends with a word
// character, so punctuation-suffixed tokens like 'import(' still match
// 'import(x)' without requiring a non-word character after the '('.
function tokenPattern(token) {
  const startsWord = /^[a-z0-9_]/i.test(token);
  const endsWord = /[a-z0-9_]$/i.test(token);
  const prefix = startsWord ? '(?<![a-z0-9_])' : '';
  const suffix = endsWord ? '(?![a-z0-9_])' : '';
  return new RegExp(`${prefix}${escapeRegExp(token)}${suffix}`, 'i');
}

function containsAnyToken(text, tokens) {
  const lower = normalizeText(text);
  if (!lower) return false;
  return tokens.some(token => {
    const t = normalizeText(token);
    return t ? tokenPattern(t).test(lower) : false;
  });
}

function hasAnyToken(text, tokens) {
  return containsAny(text, tokens);
}

function toSearchText(...values) {
  return values
    .filter(value => value !== undefined && value !== null)
    .map(value => {
      if (typeof value === 'string') return value;
      try {
        return JSON.stringify(value);
      } catch (_) {
        return String(value);
      }
    })
    .filter(Boolean)
    .join(' ');
}

function hasForbiddenCapabilities(source) {
  return containsAnyToken(source, FORBIDDEN_CAPABILITY_HINTS);
}

function hasExternalNetwork(source) {
  return containsAnyToken(source, EXTERNAL_NETWORK_HINTS);
}

function hasSnapshotAbuse(snapshotCount, snapshotDepth) {
  if (snapshotCount > 50) return true;
  if (snapshotDepth > 20) return true;
  return false;
}

function hasDestructiveCleanupIntent(...values) {
  return hasAnyToken(toSearchText(...values), DESTRUCTIVE_CLEANUP_HINTS);
}

module.exports = {
  hasForbiddenCapabilities,
  hasExternalNetwork,
  hasSnapshotAbuse,
  hasDestructiveCleanupIntent,
};
