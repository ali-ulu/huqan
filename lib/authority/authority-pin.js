'use strict';

// The pin the runtime trusts the approval authority by (#3860, ADR-016 item 9).
//
// Written once by the elevated installer next to the service's protected state
// (only administrators can write it): the port, the Ed25519 key that signs
// decisions and responses, and the X25519 key the operator client seals codes
// to. A pin that does not parse, names the wrong key types, or whose keyId does
// not match its signing key is refused -- the caller decides what that means,
// and for an installed pin it means failing closed.

const { publicKeyOf } = require('./keys');
const { isP256 } = require('./anchor-statement');
const { keyIdFor } = require('./decision-envelope');

const PIN_VERSION = 'huqan.authority.pin.v1';

// The fixed socket path is a pin field, so the pin owns what makes it safe: a
// plain absolute path with no `..` segment, which the server would bind exactly
// as spelled. An absent field keeps today's TCP transport.
function isSafeSocketPath(socketPath) {
  return typeof socketPath === 'string' && socketPath.startsWith('/') && !socketPath.split('/').includes('..');
}

/**
 * @returns {{ok: true, pin: {port: number, socketPath: string|null, keyId: string, signingKey: object, sealingKey: object, anchorKey: object|null}}
 *   | {ok: false, reason: string}}
 */
function parseAuthorityPin(text) {
  let raw;
  // PowerShell's UTF8 encoding writes a byte-order mark; it carries no meaning here.
  try { raw = JSON.parse(String(text).replace(/^\uFEFF/, '')); } catch { return { ok: false, reason: 'pin_malformed' }; }
  if (!raw || typeof raw !== 'object' || raw.v !== PIN_VERSION) return { ok: false, reason: 'pin_malformed' };
  if (!Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535) return { ok: false, reason: 'pin_malformed' };
  let signingKey;
  let sealingKey;
  let anchorKey = null;
  try {
    signingKey = publicKeyOf(raw.signingKey, 'ed25519');
    sealingKey = publicKeyOf(raw.sealingKey, 'x25519');
    // #3940: optional, so a pin written before anchoring still parses; anchoring then refuses.
    if (raw.anchorKey !== undefined) {
      anchorKey = publicKeyOf(raw.anchorKey, 'ec');
      if (!isP256(anchorKey)) return { ok: false, reason: 'pin_malformed' };
    }
  } catch {
    return { ok: false, reason: 'pin_malformed' };
  }
  if (raw.keyId !== keyIdFor(signingKey)) return { ok: false, reason: 'key_id_mismatch' };
  // The socket is optional; when present it must be a plain absolute path the
  // server would bind exactly as spelled, or the pin is refused like any other
  // malformed field.
  let socketPath = null;
  if (raw.socketPath !== undefined && raw.socketPath !== null) {
    if (!isSafeSocketPath(raw.socketPath)) return { ok: false, reason: 'pin_malformed' };
    socketPath = raw.socketPath;
  }
  return { ok: true, pin: Object.freeze({ port: raw.port, socketPath, keyId: raw.keyId, signingKey, sealingKey, anchorKey }) };
}

module.exports = { PIN_VERSION, isSafeSocketPath, parseAuthorityPin };
