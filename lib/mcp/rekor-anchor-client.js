'use strict';

// Rekor v1 client for ledger anchors (#3940, ADR-016 residual risk 7).
//
// Puts the authority's signed ledger head into the public Rekor log as a
// hashedrekord entry, and finds every anchor made with the anchor key again
// through Rekor's search index, so detection needs no local record that an
// elevated process could delete.
//
// Nothing from the log is trusted unread: each entry's signed entry timestamp
// is checked against the Rekor key pinned here, and its body must name this
// anchor key. The pin is not fetched at run time on purpose: an elevated
// process can install a root CA and answer for rekor.sigstore.dev, but it
// cannot sign as the log. The key below matched both the live
// /api/v1/log/publicKey and sigstore's TUF trusted_root.json on 2026-10-15.
//
// Lives in the UI ring with the other outbound clients; the authority service
// itself never reaches the network.

const crypto = require('node:crypto');
const https = require('node:https');

const REKOR_URL = 'https://rekor.sigstore.dev';
// The log's public SPKI (DER, base64). Public by design; held without PEM
// armor so secret scanners do not read a public key as a credential.
const REKOR_LOG_SPKI = 'MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2G2Y+2tabdTV5BcGiBIx0a9fAFwrkBbmLSGtks4L3qX6yYY0zufBnhC8Ur/iy55GhWP/9A/bY2LhC30M9+RYtw==';
const TIMEOUT_MS = 20 * 1000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const RETRIEVE_BATCH = 10;
const DEFAULT_FIND_LIMIT = 500;

class RekorError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

function publicKeyOf(key) {
  return key instanceof crypto.KeyObject && key.type === 'public' ? key : crypto.createPublicKey(key);
}

function derOf(key) {
  return publicKeyOf(key).export({ type: 'spki', format: 'der' });
}

/** A log is its key and the id derived from it; the pinned one unless a test supplies its own. */
function logOf(key) {
  const publicKey = publicKeyOf(key);
  return Object.freeze({ key: publicKey, logId: crypto.createHash('sha256').update(derOf(publicKey)).digest('hex') });
}

const PINNED_LOG = logOf(crypto.createPublicKey({ key: Buffer.from(REKOR_LOG_SPKI, 'base64'), format: 'der', type: 'spki' }));
const REKOR_LOG_ID = PINNED_LOG.logId;

function pemOf(key) {
  return publicKeyOf(key).export({ type: 'spki', format: 'pem' });
}

/** One HTTPS JSON exchange with a single deadline for the whole answer. */
function httpsTransport(method, path, body) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const url = new URL(path, REKOR_URL);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error); else resolve(value);
    };
    const request = https.request(url, { method, headers: { 'content-type': 'application/json', accept: 'application/json',
      'content-length': Buffer.byteLength(payload) } }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        else request.destroy(new RekorError('REKOR_UNAVAILABLE', 'oversized answer'));
      });
      response.on('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { json = null; }
        finish(null, { status: response.statusCode, json });
      });
      response.on('error', error => finish(new RekorError('REKOR_UNAVAILABLE', error.code || error.message)));
    });
    const deadline = setTimeout(() => request.destroy(new RekorError('REKOR_UNAVAILABLE', 'timed out')), TIMEOUT_MS);
    request.on('error', error => finish(error instanceof RekorError ? error : new RekorError('REKOR_UNAVAILABLE', error.code || error.message)));
    request.end(payload);
  });
}

// The signed entry timestamp signs the RFC 8785 form of these four fields;
// for this flat object that is sorted keys, integers and plain JSON strings.
function setVerifies(entry, log) {
  const signature = entry && entry.verification && entry.verification.signedEntryTimestamp;
  if (typeof signature !== 'string' || typeof entry.body !== 'string'
    || !Number.isInteger(entry.integratedTime) || !Number.isInteger(entry.logIndex) || typeof entry.logID !== 'string') {
    return false;
  }
  const payload = JSON.stringify({ body: entry.body, integratedTime: entry.integratedTime, logID: entry.logID, logIndex: entry.logIndex });
  try {
    return crypto.verify('sha256', Buffer.from(payload, 'utf8'), log.key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/**
 * Checks one log entry and returns what an anchor needs from it, or null when
 * anything about it does not hold: the log's signature, the log id, the entry
 * kind, or the key it was made with.
 */
function verifyLogEntry(uuid, entry, anchorPublicKey, log = PINNED_LOG) {
  if (!setVerifies(entry, log) || entry.logID !== log.logId) return null;
  let body;
  try { body = JSON.parse(Buffer.from(entry.body, 'base64').toString('utf8')); } catch { return null; }
  const spec = body && body.kind === 'hashedrekord' && body.apiVersion === '0.0.1' ? body.spec : null;
  const hash = spec && spec.data && spec.data.hash;
  const signature = spec && spec.signature;
  if (!hash || hash.algorithm !== 'sha256' || !/^[0-9a-f]{64}$/.test(hash.value || '')
    || !signature || typeof signature.content !== 'string' || !signature.publicKey) {
    return null;
  }
  try {
    const named = Buffer.from(signature.publicKey.content, 'base64').toString('utf8');
    if (!derOf(named).equals(derOf(anchorPublicKey))) return null;
  } catch {
    return null;
  }
  return { uuid, logIndex: entry.logIndex, integratedTime: entry.integratedTime, digest: hash.value, signature: signature.content };
}

function createRekorAnchorClient({ transport = httpsTransport, logKey } = {}) {
  const log = logKey ? logOf(logKey) : PINNED_LOG;
  async function call(method, path, body) {
    const answer = await transport(method, path, body);
    if (!answer || !Number.isInteger(answer.status)) throw new RekorError('REKOR_UNAVAILABLE', 'no answer');
    return answer;
  }

  /** Submits a signed anchor (lib/authority/anchor-statement.js) and returns the verified log entry. */
  async function submitAnchor(anchor, anchorPublicKey) {
    const answer = await call('POST', '/api/v1/log/entries', {
      apiVersion: '0.0.1',
      kind: 'hashedrekord',
      spec: {
        signature: { content: anchor.signature, publicKey: { content: Buffer.from(pemOf(anchorPublicKey), 'utf8').toString('base64') } },
        data: { hash: { algorithm: 'sha256', value: anchor.digest } },
      },
    });
    if (answer.status !== 201 || !answer.json || typeof answer.json !== 'object') {
      throw new RekorError('REKOR_REFUSED', `HTTP ${answer.status}${answer.json && answer.json.message ? `: ${answer.json.message}` : ''}`);
    }
    const [uuid, entry] = Object.entries(answer.json)[0] || [];
    const verified = verifyLogEntry(uuid, entry, anchorPublicKey, log);
    if (!verified || verified.digest !== anchor.digest) throw new RekorError('REKOR_UNVERIFIED', 'the log answer did not verify');
    return verified;
  }

  /**
   * Every anchor in the log made with this key, newest first, verified.
   * Bounded: at most `limit` entries are read; `truncated` says more exist.
   */
  async function findAnchors(anchorPublicKey, { limit = DEFAULT_FIND_LIMIT } = {}) {
    const found = await call('POST', '/api/v1/index/retrieve',
      { publicKey: { format: 'x509', content: Buffer.from(pemOf(anchorPublicKey), 'utf8').toString('base64') } });
    if (found.status !== 200 || !Array.isArray(found.json)) throw new RekorError('REKOR_UNAVAILABLE', `search HTTP ${found.status}`);
    const uuids = [...new Set(found.json.filter(id => typeof id === 'string'))];
    const wanted = uuids.slice(0, limit);
    const anchors = [];
    let unverified = 0;
    for (let i = 0; i < wanted.length; i += RETRIEVE_BATCH) {
      // eslint-disable-next-line no-await-in-loop
      const batch = await call('POST', '/api/v1/log/entries/retrieve', { entryUUIDs: wanted.slice(i, i + RETRIEVE_BATCH) });
      if (batch.status !== 200 || !Array.isArray(batch.json)) throw new RekorError('REKOR_UNAVAILABLE', `retrieve HTTP ${batch.status}`);
      for (const item of batch.json) {
        for (const [uuid, entry] of Object.entries(item || {})) {
          const verified = verifyLogEntry(uuid, entry, anchorPublicKey, log);
          if (verified) anchors.push(verified); else unverified += 1;
        }
      }
    }
    anchors.sort((a, b) => b.integratedTime - a.integratedTime);
    return { anchors, unverified, truncated: uuids.length > wanted.length };
  }

  return { submitAnchor, findAnchors };
}

module.exports = { REKOR_URL, REKOR_LOG_ID, RekorError, createRekorAnchorClient, verifyLogEntry };
