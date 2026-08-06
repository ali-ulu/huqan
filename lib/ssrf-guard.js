'use strict';

/**
 * SSRF Guard.
 *
 * adapters/http-adapter.js is the first place in this repo that fetches a
 * URL supplied by the caller rather than a fixed, known host (compare
 * adapters/github-adapter.js, which always targets api.github.com --
 * derived from a repo name, never an arbitrary host). "Fetch whatever URL
 * you're given" is the canonical SSRF shape: point it at
 * http://169.254.169.254/latest/meta-data (cloud instance metadata),
 * http://localhost:6379 (an internal service with no auth because it
 * trusted the network boundary), or any other address the operator never
 * intended to expose to ingest input.
 *
 * Two things have to both hold for a fetch to be safe, and this module does
 * both:
 *   1. Reject the request outright for schemes other than http/https, and
 *      for a small set of hostname literals that are obviously internal
 *      (localhost, 0.0.0.0) as a fast-path.
 *   2. Resolve DNS *before* connecting and validate every returned address
 *      against the private/reserved ranges below -- a hostname can look
 *      innocuous and still resolve to 127.0.0.1 or a metadata endpoint
 *      (DNS rebinding). All resolved addresses must be public, not just
 *      the first one, because an attacker who controls DNS can return a
 *      public decoy address first and a private one second and let
 *      round-robin or client selection logic choose the private one.
 *
 * This module does not itself open a connection. The caller is expected to
 * take the validated address from resolveSafeAddress() and pin the
 * connection to that literal IP (e.g. via http.request's `lookup` option),
 * not re-resolve the hostname at connect time -- otherwise the DNS
 * validated here and the DNS used to connect could answer differently
 * (classic TOCTOU), which defeats the whole point of resolving first.
 */

const dns = require('dns');
const net = require('net');

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

// Hostname literals that are unambiguously internal regardless of what DNS
// says about them. Defense in depth ahead of the DNS-resolution check, not
// a replacement for it.
const BLOCKED_HOSTNAME_LITERALS = new Set(['localhost', 'metadata.google.internal']);

function isPrivateIpv4(ip) {
  const parts = String(ip).split('.').map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true; // malformed input fails closed
  }
  const [a, b] = parts;
  if (a === 0) return true; // 0.0.0.0/8
  if (a === 10) return true; // 10.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local, cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
  if (a === 192 && b === 0 && parts[2] === 0) return true; // 192.0.0.0/24
  if (a === 192 && b === 0 && parts[2] === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 88 && parts[2] === 99) return true; // 192.88.99.0/24 (6to4 relay)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16
  if (a === 198 && b >= 18 && b <= 19) return true; // 198.18.0.0/15
  if (a === 198 && b === 51 && parts[2] === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && parts[2] === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
  return false;
}

function isPrivateIpv6(ip) {
  const normalized = String(ip).toLowerCase();
  if (normalized === '::1' || normalized === '::') return true; // loopback / unspecified
  if (/^::ffff:/.test(normalized)) {
    // IPv4-mapped IPv6 address -- validate the embedded IPv4 address.
    const embedded = normalized.replace(/^::ffff:/, '');
    if (net.isIPv4(embedded)) return isPrivateIpv4(embedded);
    return true; // couldn't parse the embedded address; fail closed
  }
  const firstHextet = normalized.split(':')[0];
  if (/^fe[89ab][0-9a-f]$/.test(firstHextet)) return true; // fe80::/10 link-local
  if (/^f[cd][0-9a-f]{2}$/.test(firstHextet)) return true; // fc00::/7 unique local
  return false;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateIpv4(ip);
  if (net.isIPv6(ip)) return isPrivateIpv6(ip);
  return true; // not a recognizable IP; fail closed
}

/**
 * Validates scheme + hostname literal, resolves DNS, and validates every
 * resolved address. Throws (fail-closed) on anything disallowed. On
 * success, returns { hostname, addresses, family } where addresses[0] is
 * the address the caller should pin the connection to.
 */
async function resolveSafeAddress(urlString, options = {}) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch (_) {
    const err = new Error(`ssrf-guard: not a valid URL: ${urlString}`);
    err.code = 'SSRF_INVALID_URL';
    throw err;
  }

  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    const err = new Error(`ssrf-guard: protocol not allowed: ${parsed.protocol}`);
    err.code = 'SSRF_PROTOCOL_BLOCKED';
    throw err;
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_HOSTNAME_LITERALS.has(hostname)) {
    const err = new Error(`ssrf-guard: hostname blocked: ${hostname}`);
    err.code = 'SSRF_HOSTNAME_BLOCKED';
    throw err;
  }

  const lookupImpl = options.lookupImpl || dns.promises.lookup;
  let resolved;
  try {
    resolved = await lookupImpl(hostname, { all: true, verbatim: true });
  } catch (e) {
    const err = new Error(`ssrf-guard: DNS resolution failed for ${hostname}: ${e.message}`);
    err.code = 'SSRF_DNS_FAILED';
    throw err;
  }

  const addresses = (Array.isArray(resolved) ? resolved : [resolved]).filter(Boolean);
  if (addresses.length === 0) {
    const err = new Error(`ssrf-guard: no addresses resolved for ${hostname}`);
    err.code = 'SSRF_DNS_FAILED';
    throw err;
  }

  // Test-only escape hatch: lets adapter tests exercise the real fetch path
  // against a local http.createServer() (which is necessarily bound to a
  // private address). Must never be derived from caller/user input --
  // callers pass this as a literal `true` from test code, never a value
  // that traces back to an ingest request.
  if (options.allowPrivateAddresses !== true) {
    const blocked = addresses.find((entry) => isPrivateAddress(entry.address));
    if (blocked) {
      const err = new Error(`ssrf-guard: ${hostname} resolves to a private/reserved address (${blocked.address})`);
      err.code = 'SSRF_PRIVATE_ADDRESS_BLOCKED';
      throw err;
    }
  }

  return {
    hostname,
    addresses: addresses.map((entry) => entry.address),
    family: addresses[0].family,
  };
}

module.exports = {
  isPrivateIpv4,
  isPrivateIpv6,
  isPrivateAddress,
  resolveSafeAddress,
  ALLOWED_PROTOCOLS,
};
