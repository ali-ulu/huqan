'use strict';

/**
 * AB14 — Context canary tripwire.
 *
 * A canary is a marker planted where an agent should read but never repeat:
 * a system prompt, a RAG document, a memory entry, a decoy file. If the marker
 * shows up in an action the agent is about to take, that context has leaked
 * into an outbound path, and the external action guard blocks the action and
 * records it on the admission receipt.
 *
 * The id carries its own checksum (24 random hex + 8 hex of a domain-separated
 * SHA-256), so detection needs no registry: a 32-hex token that verifies is a
 * canary with a 2^-32 chance of being an accident. That is also what keeps the
 * bare id detectable when the prefix is stripped, which plain string matching
 * (the MIRAGE prototype this replaces) could not do.
 *
 * Views scanned per string: as written; NFKC with format characters removed
 * (zero-width splitting); and base64, hex and percent-decoded payloads of those.
 * Decoding is one level deep and a decoded view is never longer than its
 * source, so a scan stays linear in the payload with no bound to game.
 * Non-goals, stated rather than half-done: an id rewritten in words,
 * translated, reversed or split across separate actions is not detected.
 *
 * The receipt never carries the id or the marker, only a fingerprint, so a
 * receipt reader cannot lift a working canary from the trail.
 */

const crypto = require('node:crypto');
const { isPlainObject } = require('./is-plain-object');

const AB14_GATE_VERSION = 'AB14-v0.1.0';
const CANARY_PREFIX = 'HUQAN-CANARY';
const CHECK_DOMAIN = 'huqan-context-canary:v1:';
const FINGERPRINT_DOMAIN = 'huqan-context-canary:fp:v1:';
const RANDOM_BYTES = 12;
const CHECK_HEX_LENGTH = 8;

const CONTEXT_CANARY_REASONS = Object.freeze({
  TRIPPED: 'context_canary_tripwire',
  CLEAN: 'no_context_canary',
});

const PREFIXED_PATTERN = /huqan\W{0,3}canary\W{0,3}((?:[0-9a-f]\W?){31}[0-9a-f])/gi;
const BARE_PATTERN = /(?<![0-9a-f])[0-9a-f]{32}(?![0-9a-f])/gi;
const UUID_SHAPE_PATTERN = /(?<![0-9a-f])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f])/gi;
const BASE64_PATTERN = /[A-Za-z0-9+/_-]{24,}={0,2}/g;
const HEX_TEXT_PATTERN = /(?<![0-9a-f])(?:[0-9a-f]{2}){24,}(?![0-9a-f])/gi;
const PERCENT_PATTERN = /%[0-9a-f]{2}/i;
const FORMAT_CHARS = /\p{Cf}/gu;

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function checkDigits(randomHex) {
  return sha256Hex(CHECK_DOMAIN + randomHex).slice(0, CHECK_HEX_LENGTH);
}

function isContextCanaryId(value) {
  const id = String(value || '').toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(id)) return false;
  return checkDigits(id.slice(0, -CHECK_HEX_LENGTH)) === id.slice(-CHECK_HEX_LENGTH);
}

function canaryFingerprint(canaryId) {
  return sha256Hex(FINGERPRINT_DOMAIN + String(canaryId).toLowerCase()).slice(0, 16);
}

/** A fresh canary. `randomBytes` is injectable for deterministic tests. */
function issueContextCanary({ randomBytes = crypto.randomBytes } = {}) {
  const randomHex = Buffer.from(randomBytes(RANDOM_BYTES)).toString('hex');
  const canaryId = randomHex + checkDigits(randomHex);
  return Object.freeze({
    canaryId,
    marker: `[[${CANARY_PREFIX}:${canaryId}]]`,
    fingerprint: canaryFingerprint(canaryId),
    gateVersion: AB14_GATE_VERSION,
  });
}

/**
 * Plant a canary into the string fields of an outbound payload.
 *
 * AB14 above only *detects* a marker that is already present; something has to
 * put one there. On the live egress path the risky context IS the payload the
 * gate is about to let leave, so the gate marks it: the marker travels with the
 * payload and AB14 blocks on it. Values are rewritten, keys are left untouched
 * so the payload's shape -- and every other gate that reads it -- is unchanged.
 * A copy is returned; the caller's payload is never mutated. The marker is
 * exposed so the caller can hand it to the context it protects, but a receipt
 * reader must only ever see `fingerprint`.
 */
function plantContextCanaryInValue(value, { signalIds = [] } = {}) {
  const canary = issueContextCanary();
  const plant = (node) => {
    if (typeof node === 'string') return node ? `${node} ${canary.marker}` : canary.marker;
    if (Array.isArray(node)) return node.map(plant);
    if (isPlainObject(node)) {
      const out = {};
      for (const [key, child] of Object.entries(node)) out[key] = plant(child);
      return out;
    }
    return node;
  };
  return Object.freeze({
    payload: plant(value),
    canaryId: canary.canaryId,
    marker: canary.marker,
    fingerprint: canary.fingerprint,
    signalIds: [...(Array.isArray(signalIds) ? signalIds : [])].map(String).sort(),
    gateVersion: AB14_GATE_VERSION,
  });
}

function idsInView(text, encoding, hits) {
  const add = (raw) => {
    const id = raw.replace(/[^0-9a-f]/gi, '').toLowerCase();
    if (isContextCanaryId(id)) hits.push({ id, encoding });
  };
  for (const match of text.matchAll(PREFIXED_PATTERN)) add(match[1]);
  for (const match of text.matchAll(BARE_PATTERN)) add(match[0]);
  for (const match of text.matchAll(UUID_SHAPE_PATTERN)) add(match[0]);
}

function percentDecode(text) {
  try { return decodeURIComponent(text); } catch { return unescape(text); }
}

function decodedViews(text) {
  const views = [];
  for (const match of text.matchAll(BASE64_PATTERN)) {
    const token = match[0].replace(/-/g, '+').replace(/_/g, '/');
    views.push([Buffer.from(token, 'base64').toString('utf8'), 'base64']);
  }
  for (const match of text.matchAll(HEX_TEXT_PATTERN)) {
    views.push([Buffer.from(match[0], 'hex').toString('utf8'), 'hex']);
  }
  if (PERCENT_PATTERN.test(text)) views.push([percentDecode(text), 'percent']);
  return views;
}

function normalize(text) {
  return text.normalize('NFKC').replace(FORMAT_CHARS, '');
}

function scanString(text, hits) {
  const normalized = normalize(text);
  const bases = normalized === text ? [text] : [text, normalized];
  idsInView(text, 'plain', hits);
  if (normalized !== text) idsInView(normalized, 'normalized', hits);
  for (const base of bases) {
    for (const [decoded, encoding] of decodedViews(base)) idsInView(normalize(decoded), encoding, hits);
  }
}

function walk(value, hits, seen) {
  if (typeof value === 'string') { scanString(value, hits); return; }
  if (!Array.isArray(value) && !isPlainObject(value)) return;
  if (seen.has(value)) return;
  seen.add(value);
  const items = Array.isArray(value) ? value : [...Object.keys(value), ...Object.values(value)];
  for (const item of items) walk(item, hits, seen);
}

/**
 * Scans any JSON-shaped value, keys included, for context canaries.
 *
 * Returns fingerprints and the encodings they were found in, never the ids.
 * `decision` is block on a hit and allow otherwise.
 */
function evaluateContextCanaries(value) {
  const hits = [];
  walk(value, hits, new WeakSet());
  const fingerprints = [...new Set(hits.map((hit) => canaryFingerprint(hit.id)))].sort();
  const encodings = [...new Set(hits.map((hit) => hit.encoding))].sort();
  const tripped = fingerprints.length > 0;
  return Object.freeze({
    decision: tripped ? 'block' : 'allow',
    reason: tripped ? CONTEXT_CANARY_REASONS.TRIPPED : CONTEXT_CANARY_REASONS.CLEAN,
    canaryFingerprints: Object.freeze(fingerprints),
    encodings: Object.freeze(encodings),
    gateVersion: AB14_GATE_VERSION,
  });
}

module.exports = {
  AB14_GATE_VERSION,
  CANARY_PREFIX,
  CONTEXT_CANARY_REASONS,
  canaryFingerprint,
  evaluateContextCanaries,
  isContextCanaryId,
  issueContextCanary,
  plantContextCanaryInValue,
};
