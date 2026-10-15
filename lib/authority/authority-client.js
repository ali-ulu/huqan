'use strict';

// The runtime's client for the approval authority (#3860, ADR-016 items 5, 9).
//
// Every call sends a fresh 32-byte challenge and accepts only an answer signed
// by the pinned key over that challenge and this exact request. Anything else
// -- an unsigned answer, another key, a replayed or re-routed answer -- is an
// impostor on the authority's port and raises AUTHORITY_IMPERSONATION; a
// refused connection or a timeout raises AUTHORITY_UNAVAILABLE. The caller
// never sees an unverified body.
//
// A caller in service mode treats both errors as a refusal and never falls
// back to the legacy path: an impostor that hangs or closes the port looks
// exactly like a service that is down.

const crypto = require('node:crypto');
const http = require('node:http');
const { verifyResponse, requestDigestOf } = require('./decision-envelope');

const TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const APPROVAL_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

class AuthorityError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.code = code;
  }
}

// One deadline for the whole exchange, not a socket idle timeout: an impostor
// that drips a byte every few seconds would otherwise hold the caller open.
function exchange({ port, method, path, payload, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const challenge = crypto.randomBytes(32).toString('hex');
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) reject(error);
      else resolve(value);
    };
    const request = http.request({ host: '127.0.0.1', port, method, path, headers: {
      host: `127.0.0.1:${port}`, 'x-huqan-challenge': challenge, 'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    } }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size <= MAX_RESPONSE_BYTES) chunks.push(chunk);
        else request.destroy(new AuthorityError('AUTHORITY_IMPERSONATION', 'oversized answer'));
      });
      response.on('error', error => finish(error instanceof AuthorityError ? error
        : new AuthorityError('AUTHORITY_UNAVAILABLE', error.code || error.message)));
      response.on('aborted', () => finish(new AuthorityError('AUTHORITY_UNAVAILABLE', 'answer aborted')));
      response.on('end', () => finish(null, { challenge, text: Buffer.concat(chunks).toString('utf8') }));
    });
    const deadline = setTimeout(() => request.destroy(new AuthorityError('AUTHORITY_UNAVAILABLE', 'timed out')), timeoutMs);
    request.on('error', error => finish(error instanceof AuthorityError ? error
      : new AuthorityError('AUTHORITY_UNAVAILABLE', error.code || error.message)));
    request.end(payload);
  });
}

function createAuthorityClient({ pin, timeoutMs = TIMEOUT_MS }) {
  async function call(method, path, body) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const { challenge, text } = await exchange({ port: pin.port, method, path, payload, timeoutMs });
    let response;
    try { response = JSON.parse(text); } catch { throw new AuthorityError('AUTHORITY_IMPERSONATION', 'unsigned answer'); }
    const verified = verifyResponse(response, { publicKey: pin.signingKey, challenge, method, path,
      requestDigest: requestDigestOf(payload) });
    if (!verified.ok) throw new AuthorityError('AUTHORITY_IMPERSONATION', verified.code);
    const { status, body: answer } = verified.body || {};
    if (!Number.isInteger(status)) throw new AuthorityError('AUTHORITY_IMPERSONATION', 'answer carries no status');
    return { status, body: answer };
  }

  // The same shape the service accepts. Checked here so '..' or a non-string can
  // never reach a path the server would normalise differently than it signs.
  const id = (approvalId) => {
    if (typeof approvalId !== 'string' || !APPROVAL_ID.test(approvalId) || /^\.{1,2}$/.test(approvalId)) {
      throw new AuthorityError('INVALID_APPROVAL_ID', 'approval ids are 1-128 of [A-Za-z0-9_.:-]');
    }
    return encodeURIComponent(approvalId);
  };
  // Paged ledger reads for detection (`huqan audit --authority`). Bounded so
  // a deep ledger cannot turn an audit into a memory hog; callers page on.
  const seq = (value, name, min = 0) => {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isInteger(parsed) || parsed < min || parsed > 4294967295) {
      throw new AuthorityError('INVALID_LEDGER_CURSOR', `${name} is an integer >= ${min}`);
    }
    return parsed;
  };
  return {
    identity: () => call('GET', '/v1/identity'),
    register: approval => call('POST', '/v1/approvals', approval),
    list: () => call('GET', '/v1/approvals'),
    show: approvalId => call('GET', `/v1/approvals/${id(approvalId)}`),
    decide: (approvalId, sealed) => call('POST', `/v1/approvals/${id(approvalId)}/decision`, { sealed }),
    withdraw: (approvalId, sealed) => call('POST', `/v1/approvals/${id(approvalId)}/withdraw`, { sealed }),
    getDecision: approvalId => call('GET', `/v1/approvals/${id(approvalId)}/decision`),
    consume: (approvalId, proof) => call('POST', `/v1/approvals/${id(approvalId)}/consume`, proof),
    recordOutcome: (approvalId, outcome) => call('POST', `/v1/approvals/${id(approvalId)}/outcome`, outcome),
    recordStop: stop => call('POST', '/v1/stops', stop),
    ledgerHead: () => call('GET', '/v1/ledger/head'),
    ledgerEntries: ({ fromSeq = 0, limit = 500 } = {}) =>
      call('GET', `/v1/ledger?fromSeq=${seq(fromSeq, 'fromSeq')}&limit=${Math.min(seq(limit, 'limit', 1), 500)}`),
  };
}

module.exports = { AuthorityError, createAuthorityClient };
