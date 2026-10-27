// SPDX-License-Identifier: LicenseRef-HUQAN-Enterprise
'use strict';

// SAML 2.0 AuthnResponse / Assertion validation.
//
// Every check is fail-closed: a missing field, malformed time stamp, or
// failed cryptographic check refuses the login. The returned `result` object
// carries a `code` that maps to the failure codes documented in
// docs/sso-saml.md.
//
// The signature verification uses xml-crypto (W3C C14N + XML-DSig) via
// lib/saml/signature.js, which accepts both Response-signed and
// Assertion-signed documents. No runtime metadata fetch; all trust comes from
// the administrator-imported IdP metadata.

const { XMLParser } = require('fast-xml-parser');
const { verifySamlSignature, extractCertificatesFromMetadata } = require('./signature');

const DEFAULT_CLOCK_SKEW_MS = 5 * 60 * 1000;
const SUCCESS_STATUS = 'urn:oasis:names:tc:SAML:2.0:status:Success';
const BEARER_METHOD = 'urn:oasis:names:tc:SAML:2.0:cm:bearer';
const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_RESPONSE_BYTES = 256 * 1024;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  textNodeName: '#text',
  parseAttributeValue: false,
  trimValues: true,
  isArray: (name) => ['Attribute', 'Audience', 'SubjectConfirmation', 'AttributeStatement', 'SingleSignOnService', 'KeyDescriptor', 'X509Certificate'].includes(name),
});

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

// fast-xml-parser preserves namespace prefixes (samlp:Status, saml:Issuer),
// and their presence is not guaranteed: an IdP may move a prefix or drop it.
// Every SAML structural lookup must therefore match by local name, prefix
// and all, and must not trust a single spelling.
function child(node, localName) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return undefined;
  for (const key of Object.keys(node)) {
    if (key === localName || key.endsWith(`:${localName}`)) return node[key];
  }
  return undefined;
}

function textOf(node) {
  if (node === undefined || node === null) return undefined;
  if (typeof node === 'string') return node;
  if (node['#text'] !== undefined) return node['#text'];
  return undefined;
}

function parseInstant(value) {
  if (typeof value !== 'string') return Number.NaN;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) return Number.NaN;
  return Date.parse(value);
}

/**
 * Validate a SAML 2.0 AuthnResponse (or Assertion) delivered to the ACS.
 *
 * @param {string} xml - raw SAMLResponse base64-decoded XML
 * @param {object} opts
 * @returns {{ok: true, assertionId, inResponseTo, issuer, subject, attributes, sessionNotOnOrAfter}
 *   | {ok: false, code, message}}
 */
function validateResponse(xml, opts = {}) {
  if (typeof xml !== 'string' || xml.length === 0) {
    return { ok: false, code: 'malformed_response', message: 'SAMLResponse must be a non-empty string' };
  }
  if (xml.length > MAX_RESPONSE_BYTES) {
    return { ok: false, code: 'response_too_large', message: 'SAMLResponse exceeds the 256 KiB bound' };
  }

  let parsed;
  try {
    parsed = parser.parse(xml);
  } catch (error) {
    return { ok: false, code: 'malformed_response', message: `SAMLResponse is not well-formed XML: ${error.message}` };
  }

  const resp = parsed['samlp:Response'] || parsed.Response || child(parsed, 'Response');
  if (!resp || typeof resp !== 'object') {
    return { ok: false, code: 'malformed_response', message: 'no samlp:Response element found' };
  }

  // Version.
  const version = textOf(resp['@_Version']);
  if (version !== '2.0') {
    return { ok: false, code: 'unsupported_version', message: `SAML Version must be 2.0, got ${JSON.stringify(version)}` };
  }

  // Destination.
  const destination = textOf(resp['@_Destination']);
  if (typeof opts.acsUrl === 'string' && opts.acsUrl !== '' && destination !== opts.acsUrl) {
    return { ok: false, code: 'destination_mismatch', message: 'Response Destination does not match the ACS endpoint' };
  }

  // Request correlation.
  const inResponseTo = textOf(resp['@_InResponseTo']);
  if (opts.expectedInResponseTo !== undefined) {
    if (typeof opts.expectedInResponseTo === 'string' && opts.expectedInResponseTo !== '' && inResponseTo !== opts.expectedInResponseTo) {
      return { ok: false, code: 'request_correlation_mismatch', message: 'InResponseTo does not match the initiated AuthnRequest' };
    }
    if (opts.expectedInResponseTo === null && inResponseTo) {
      return { ok: false, code: 'unexpected_in_response_to', message: 'response answers a request the SP did not issue' };
    }
  }

  // Status.
  const statusNode = child(resp, 'Status');
  const statusCodeNode = statusNode ? child(statusNode, 'StatusCode') : undefined;
  const status = statusCodeNode
    ? textOf(child(statusCodeNode, 'Value') || statusCodeNode['@_Value'])
    : undefined;
  if (status !== SUCCESS_STATUS) {
    return { ok: false, code: 'status_not_success', message: `response status is ${JSON.stringify(status)}, only Success is accepted` };
  }

  // Assertions.
  const assertions = asArray(child(resp, 'Assertion'));
  if (assertions.length === 0) {
    return { ok: false, code: 'missing_assertion', message: 'response carries no Assertion' };
  }
  if (assertions.length > 1) {
    return { ok: false, code: 'too_many_assertions', message: 'response carries more than one Assertion' };
  }
  const assertion = assertions[0];
  if (!assertion || typeof assertion !== 'object') {
    return { ok: false, code: 'malformed_response', message: 'Assertion element is not an object' };
  }

  const assertionVersion = textOf(assertion['@_Version']);
  if (assertionVersion !== '2.0') {
    return { ok: false, code: 'unsupported_version', message: 'Assertion Version must be 2.0' };
  }

  // Signature: verified against trusted certificates from imported metadata.
  // The signature verification accepts both Response-signed (enveloped) and
  // Assertion-signed documents. Both are bound to the XML document itself,
  // preventing signature-wrapping / assertion-swap attacks.
  const trustedCerts = Array.isArray(opts.trustedCertificates) ? opts.trustedCertificates : [];
  if (trustedCerts.length === 0) {
    return { ok: false, code: 'no_trusted_certificates', message: 'no trusted IdP certificate is configured' };
  }
  const signatureResult = verifySamlSignature(xml, trustedCerts, { allowAssertionSigned: true });
  if (!signatureResult.ok) {
    return { ok: false, code: `signature_${signatureResult.code}`, message: `signature verification failed: ${signatureResult.code}` };
  }

  // Issuer.
  const issuer = textOf(child(assertion, 'Issuer'));
  if (issuer !== opts.expectedIssuer) {
    return { ok: false, code: 'issuer_mismatch', message: 'assertion Issuer does not match the trusted IdP entityID' };
  }

  // Time window.
  const now = typeof opts.now === 'number' ? opts.now : Date.now();
  const skew = typeof opts.clockSkewMs === 'number' ? opts.clockSkewMs : DEFAULT_CLOCK_SKEW_MS;
  const conditions = child(assertion, 'Conditions') || {};
  const notBefore = parseInstant(textOf(conditions['@_NotBefore']));
  const notOnOrAfter = parseInstant(textOf(conditions['@_NotOnOrAfter']));
  if (!Number.isFinite(notBefore) || !Number.isFinite(notOnOrAfter)) {
    return { ok: false, code: 'malformed_conditions', message: 'assertion Conditions NotBefore/NotOnOrAfter are missing or malformed' };
  }
  if (notOnOrAfter <= notBefore) {
    return { ok: false, code: 'malformed_conditions', message: 'assertion NotOnOrAfter must be after NotBefore' };
  }
  if (now + skew < notBefore) {
    return { ok: false, code: 'assertion_not_yet_valid', message: 'assertion is not yet valid (NotBefore in the future)' };
  }
  if (now - skew >= notOnOrAfter) {
    return { ok: false, code: 'assertion_expired', message: 'assertion has expired (NotOnOrAfter in the past)' };
  }
  if (notOnOrAfter - notBefore > MAX_WINDOW_MS) {
    return { ok: false, code: 'assertion_window_unbounded', message: 'assertion time window exceeds 24h' };
  }

  // Audience.
  const audiences = asArray(child(conditions, 'AudienceRestriction') ? child(child(conditions, 'AudienceRestriction'), 'Audience') : child(conditions, 'Audience')).map(textOf).filter(v => typeof v === 'string');
  if (!audiences.includes(opts.spEntityId)) {
    return { ok: false, code: 'audience_mismatch', message: 'assertion Audience does not include this SP entity ID' };
  }

  // Subject.
  const subject = child(assertion, 'Subject');
  if (!subject) {
    return { ok: false, code: 'missing_subject', message: 'assertion has no Subject' };
  }
  const nameId = textOf(child(subject, 'NameID'));
  if (typeof nameId !== 'string' || !nameId) {
    return { ok: false, code: 'missing_name_id', message: 'Subject has no NameID' };
  }
  const confirmations = asArray(child(subject, 'SubjectConfirmation')).filter(c =>
    c && textOf(c['@_Method']) === BEARER_METHOD);
  if (confirmations.length === 0) {
    return { ok: false, code: 'missing_subject_confirmation', message: 'Subject has no Bearer SubjectConfirmation' };
  }
  const confirmationData = child(confirmations[0], 'SubjectConfirmationData') || {};
  const recipient = textOf(confirmationData['@_Recipient']);
  if (typeof opts.acsUrl === 'string' && opts.acsUrl !== '' && recipient !== opts.acsUrl) {
    return { ok: false, code: 'recipient_mismatch', message: 'SubjectConfirmationData Recipient does not match the ACS endpoint' };
  }
  const confNotBefore = parseInstant(textOf(confirmationData['@_NotBefore']));
  const confNotOnOrAfter = parseInstant(textOf(confirmationData['@_NotOnOrAfter']));
  if (!Number.isFinite(confNotBefore) || !Number.isFinite(confNotOnOrAfter)) {
    return { ok: false, code: 'malformed_confirmation', message: 'SubjectConfirmationData time window is missing or malformed' };
  }
  if (now + skew < confNotBefore || now - skew >= confNotOnOrAfter) {
    return { ok: false, code: 'confirmation_outside_window', message: 'SubjectConfirmationData is outside its validity window' };
  }

  // AuthnStatement.
  const authnStatements = asArray(child(assertion, 'AuthnStatement'));
  if (authnStatements.length === 0) {
    return { ok: false, code: 'missing_authn_statement', message: 'assertion has no AuthnStatement' };
  }
  for (const statement of authnStatements) {
    const sessionNotOnOrAfter = parseInstant(textOf(statement['@_SessionNotOnOrAfter']));
    if (Number.isFinite(sessionNotOnOrAfter) && sessionNotOnOrAfter < now - skew) {
      return { ok: false, code: 'session_expired', message: 'authenticating session has expired' };
    }
  }

  // Attributes: normalized, bounded, never granting.
  const attributes = {};
  for (const statement of asArray(child(assertion, 'AttributeStatement'))) {
    for (const attr of asArray(child(statement, 'Attribute'))) {
      const name = textOf(attr['@_Name']);
      if (typeof name !== 'string' || !name) continue;
      const values = asArray(child(attr, 'AttributeValue')).map(textOf).filter(v => typeof v === 'string');
      if (name.length > 256 || values.length === 0 || values.length > 64 || values.some(v => v.length > 4096)) {
        return { ok: false, code: 'attribute_malformed', message: `attribute ${name} is malformed or exceeds its bound` };
      }
      attributes[name] = values;
    }
  }

  return {
    ok: true,
    assertionId: textOf(assertion['@_ID']) || null,
    inResponseTo: typeof inResponseTo === 'string' ? inResponseTo : null,
    issuer,
    subject: Object.freeze({ nameId }),
    attributes: Object.freeze(attributes),
    sessionNotOnOrAfter: authnStatements.map(s => parseInstant(textOf(s['@_SessionNotOnOrAfter']))).filter(Number.isFinite)[0] || null,
  };
}

module.exports = {
  DEFAULT_CLOCK_SKEW_MS,
  validateResponse,
};