'use strict';

// SAML 2.0 SP test fixtures (#4214).
//
// Controlled, self-signed fixtures: the IdP private key is generated here so
// every test can sign its own assertion without touching the network or the
// filesystem. The trusted certificate is the public half of the same key, so
// the SP's signature verification succeeds. The fixture builder is a test
// helper, not part of the production code path.

const crypto = require('node:crypto');
const { signSamlResponse, signSamlAssertion } = require('../../lib/saml/signature');

const IDP_ENTITY_ID = 'https://idp.example.test';
const SP_ENTITY_ID = 'https://sp.example.test';
const ACS_URL = 'https://sp.example.test/saml/acs';
const NAME_ID = 'operator-1';

function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    publicKey: publicKey.export({ type: 'spki', format: 'pem' }),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

function buildResponse(opts = {}) {
  const id = opts.id || 'R-1';
  const assertionId = opts.assertionId || 'A-1';
  const issuer = opts.issuer || IDP_ENTITY_ID;
  const nameId = opts.nameId || NAME_ID;
  const status = opts.status || 'urn:oasis:names:tc:SAML:2.0:status:Success';
  const inResponseTo = opts.inResponseTo === undefined ? 'req-1' : opts.inResponseTo;
  const audience = opts.audience || SP_ENTITY_ID;
  const attributes = opts.attributes || {};
  const recipient = opts.recipient || ACS_URL;
  const confirmationMethod = opts.confirmationMethod ?? 'urn:oasis:names:tc:SAML:2.0:cm:bearer';
  // Time stamps default to a window that spans "now", so a fixture stays
  // valid however long the test suite has been running. Explicit overrides
  // are honoured verbatim (the expired/unbounded-window tests use them).
  const base = opts.now === undefined ? Date.now() : opts.now;
  const notBefore = opts.notBefore || new Date(base - 60_000).toISOString();
  const notOnOrAfter = opts.notOnOrAfter || new Date(base + 60_000).toISOString();
  const sessionNotOnOrAfter = opts.sessionNotOnOrAfter || new Date(base + 3_600_000).toISOString();

  const attributeXml = Object.entries(attributes).map(([name, values]) => {
    const valuesXml = values.map(v => `<saml:AttributeValue>${escapeXml(v)}</saml:AttributeValue>`).join('');
    return `<saml:Attribute Name="${escapeXml(name)}">${valuesXml}</saml:Attribute>`;
  }).join('');

  const confirmationMethodAttr = confirmationMethod
    ? ` Method="${escapeXml(confirmationMethod)}"`
    : '';
  // When the confirmation method is absent the element is dropped entirely:
  // the validator refuses it, which is what a fixture testing the refusal wants.

  return [
    `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="${escapeXml(id)}" Version="2.0" Destination="${escapeXml(ACS_URL)}"`,
    `  InResponseTo="${escapeXml(inResponseTo)}">`,
    `  <samlp:Status><samlp:StatusCode Value="${escapeXml(status)}"/></samlp:Status>`,
    `  <saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${escapeXml(assertionId)}" Version="2.0">`,
    `    <saml:Issuer>${escapeXml(issuer)}</saml:Issuer>`,
    `    <saml:Conditions NotBefore="${escapeXml(notBefore)}" NotOnOrAfter="${escapeXml(notOnOrAfter)}">`,
    `      <saml:AudienceRestriction><saml:Audience>${escapeXml(audience)}</saml:Audience></saml:AudienceRestriction>`,
    `    </saml:Conditions>`,
    `    <saml:Subject>`,
    `      <saml:NameID>${escapeXml(nameId)}</saml:NameID>`,
    `      <saml:SubjectConfirmation${confirmationMethodAttr}>`,
    `        <saml:SubjectConfirmationData Recipient="${escapeXml(recipient)}" NotBefore="${escapeXml(notBefore)}" NotOnOrAfter="${escapeXml(notOnOrAfter)}"/>`,
    `      </saml:SubjectConfirmation>`,
    `    </saml:Subject>`,
    `    <saml:AuthnStatement SessionNotOnOrAfter="${escapeXml(sessionNotOnOrAfter)}"/>`,
    `    <saml:AttributeStatement>${attributeXml}</saml:AttributeStatement>`,
    `  </saml:Assertion>`,
    `</samlp:Response>`,
  ].join('\n');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function signFixture(opts = {}) {
  const { publicKey, privateKey } = generateKeyPair();
  const xml = buildResponse(opts);
  const signed = signSamlResponse(xml, privateKey);
  return {
    publicKey,
    privateKey,
    xml,
    signed,
    certPem: publicKey, // the trusted certificate is the public half
  };
}

module.exports = {
  IDP_ENTITY_ID,
  SP_ENTITY_ID,
  ACS_URL,
  NAME_ID,
  generateKeyPair,
  buildResponse,
  signFixture,
  signSamlResponse,
  signSamlAssertion,
};