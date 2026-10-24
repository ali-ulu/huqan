'use strict';

// SAML 2.0 signature verification using xml-crypto (W3C C14N + XML-DSig).
//
// This module wraps xml-crypto's SignedXml for the two SAML patterns:
//   1. Response-signed: enveloped signature over the entire samlp:Response
//   2. Assertion-signed: signature over the saml:Assertion by ID
//
// Both are accepted; the caller passes the full XML document returned by
// getSignedXml() (or the raw response it received). The verification is
// fail-closed: missing Signature, malformed XML, or an untrusted certificate
// all refuse the login. This module does NOT fetch metadata or trust anchors;
// those are provided by the caller from the imported IdP metadata.

const { SignedXml } = require('xml-crypto');
const crypto = require('node:crypto');

const C14N_EXC = 'http://www.w3.org/2001/10/xml-exc-c14n#';
const SHA256_DIGEST = 'http://www.w3.org/2001/04/xmlenc#sha256';
const RSA_SHA256 = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';

function extractCertificatesFromMetadata(metadata) {
  if (!Array.isArray(metadata.x509Cert)) return [];
  return metadata.x509Cert;
}

function getFingerprint(certPem) {
  const match = certPem.match(/-----BEGIN CERTIFICATE-----\n([\s\S]+)\n-----END CERTIFICATE-----/);
  if (!match) return null;
  const der = Buffer.from(match[1].replace(/\s/g, ''), 'base64');
  return crypto.createHash('sha256').update(der).digest('hex').toUpperCase();
}

/**
 * Normalize a document so xml-crypto can find the Signature element.
 * xml-crypto's loadSignature searches for a ds:Signature (or Signature in
 * the xmldsig# namespace) in the root document. Documents that place the
 * Signature inside a saml:Assertion (assertion-signed) are handled by
 * xml-crypto's findSignatures, which walks the whole tree.
 *
 * A default-namespace Signature (no prefix, xmlns=...) is valid XML-DSig;
 * we add a ds: prefix alias so xml-crypto's XPath-based finder matches it.
 */
function normalizeSignatureNamespace(xml) {
  // xml-crypto uses xpath to find Signature elements. Its resolver maps
  // ds: -> http://www.w3.org/2000/09/xmldsig#. A default namespace Signature
  // is not matched by that resolver, so rewrite it to use the ds: prefix.
  return xml.replace(
    /<Signature xmlns="http:\/\/www\.w3\.org\/2000\/09\/xmldsig#">/g,
    '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#">',
  ).replace(
    /<\/Signature>/g,
    '</ds:Signature>',
  );
}

function tryVerifyWithCerts(xml, trustedCerts) {
  let lastError = null;

  // Extract the Signature element (only one is allowed per document; a second
  // one is a signature-wrapping attempt and the caller refuses it before the
  // crypto check).
  const signatureStart = xml.search(/<(?:ds:)?Signature[\s>]/);
  if (signatureStart < 0) {
    return { ok: false, code: 'missing_signature', message: 'document carries no Signature element' };
  }
  const signatureEnd = xml.lastIndexOf('</' + (xml.indexOf('<ds:Signature') >= 0 ? 'ds:Signature>' : 'Signature>'))
    + (xml.indexOf('<ds:Signature') >= 0 ? '</ds:Signature>'.length : '</Signature>'.length);
  if (signatureEnd < signatureStart) {
    return { ok: false, code: 'missing_signature', message: 'Signature element is not well-formed' };
  }
  // More than one Signature means the document was tampered with (wrapping).
  const extraChecks = xml.slice(0, signatureStart) + xml.slice(signatureEnd);
  if (/<(?:ds:)?Signature[\s>]/.test(extraChecks)) {
    return { ok: false, code: 'multiple_signatures', message: 'document contains more than one Signature element' };
  }
  const signatureXml = xml.slice(signatureStart, signatureEnd);

  for (const certPem of trustedCerts) {
    try {
      const verifier = new SignedXml({
        publicCert: certPem,
        validateReferenceResources: true,
      });
      // loadSignature takes the Signature fragment; checkSignature takes the
      // full document so the enveloped-signature transform can verify the
      // SignedInfo and the reference digest against their original context.
      verifier.loadSignature(signatureXml);
      // checkSignature takes the full document so the enveloped-signature
      // transform verifies SignedInfo and the reference digest in context.
      // (getSignedReferences() may report 0 before checkSignature runs the
      // reference validation itself; it is not a reliable gate.)
      const ok = verifier.checkSignature(xml);
      if (ok) {
        return { ok: true, certPem, fingerprint: getFingerprint(certPem), pattern: inferPattern(xml) };
      }
      lastError = 'signature_invalid';
    } catch (error) {
      lastError = error.message;
      continue;
    }
  }

  if (lastError === 'signature_invalid') {
    return { ok: false, code: 'signature_invalid', message: 'no trusted certificate verified the signature' };
  }
  return { ok: false, code: 'missing_signature', message: `signature verification failed: ${lastError}` };
}

function inferPattern(xml) {
  if (xml.includes('<saml:Assertion') || xml.includes('Assertion')) return 'assertion_signed';
  return 'response_signed';
}

function verifySamlSignature(xml, trustedCerts, opts = {}) {
  if (typeof xml !== 'string' || xml.length === 0) {
    return { ok: false, code: 'malformed_xml', message: 'SAML XML must be a non-empty string' };
  }
  if (!Array.isArray(trustedCerts) || trustedCerts.length === 0) {
    return { ok: false, code: 'no_trusted_certificates', message: 'no trusted IdP certificate configured' };
  }
  return tryVerifyWithCerts(xml, trustedCerts, opts);
}

function signSamlResponse(responseXml, privateKeyPem) {
  const signer = new SignedXml({
    canonicalizationAlgorithm: C14N_EXC,
    signatureAlgorithm: RSA_SHA256,
  });
  signer.privateKey = privateKeyPem;
  signer.addReference({
    xpath: '/*',
    transforms: ['http://www.w3.org/2000/09/xmldsig#enveloped-signature', C14N_EXC],
    digestAlgorithm: SHA256_DIGEST,
    uri: '',
  });
  signer.computeSignature(responseXml);
  return signer.getSignedXml();
}

function signSamlAssertion(assertionXml, privateKeyPem, assertionId) {
  const signer = new SignedXml({
    canonicalizationAlgorithm: C14N_EXC,
    signatureAlgorithm: RSA_SHA256,
  });
  signer.privateKey = privateKeyPem;
  signer.addReference({
    xpath: `//*[@ID='${assertionId}']`,
    transforms: [C14N_EXC],
    digestAlgorithm: SHA256_DIGEST,
    uri: `#${assertionId}`,
  });
  signer.computeSignature(assertionXml);
  return signer.getSignedXml();
}

module.exports = {
  C14N_EXC,
  SHA256_DIGEST,
  RSA_SHA256,
  extractCertificatesFromMetadata,
  verifySamlSignature,
  signSamlResponse,
  signSamlAssertion,
  getFingerprint,
};