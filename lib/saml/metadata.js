'use strict';

const { XMLParser } = require('fast-xml-parser');
const crypto = require('node:crypto');

const NAMESPACES = Object.freeze({
  SAMLP: 'urn:oasis:names:tc:SAML:2.0:protocol',
  SAML: 'urn:oasis:names:tc:SAML:2.0:assertion',
  DS: 'http://www.w3.org/2000/09/xmldsig#',
  XS: 'http://www.w3.org/2001/XMLSchema',
});

function parseIdPMetadataXml(xmlString) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseAttributeValue: false,
    trimValues: true,
    isArray: (name) => ['SingleSignOnService', 'SingleLogoutService', 'KeyDescriptor', 'X509Certificate'].includes(name),
  });

  try {
    const parsed = parser.parse(xmlString);
    return parsed.EntityDescriptor || parsed['md:EntityDescriptor'] || null;
  } catch (error) {
    throw new Error(`Failed to parse IdP metadata XML: ${error.message}`);
  }
}

function extractMetadata(entityDescriptor) {
  if (!entityDescriptor) {
    throw new Error('Invalid IdP metadata: missing EntityDescriptor');
  }

  const entityID = entityDescriptor['@_entityID'] || entityDescriptor.entityID;
  if (!entityID) {
    throw new Error('Invalid IdP metadata: missing entityID');
  }

  const idpSsoDescriptor = entityDescriptor.IDPSSODescriptor || entityDescriptor['md:IDPSSODescriptor'];
  if (!idpSsoDescriptor) {
    throw new Error('Invalid IdP metadata: missing IDPSSODescriptor');
  }

  // Extract SingleSignOnService
  const ssoServices = idpSsoDescriptor.SingleSignOnService || idpSsoDescriptor['md:SingleSignOnService'] || [];
  const singleSignOnService = ssoServices
    .filter(s => s['@_Binding'] === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST' || s['@_Binding'] === 'urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect')
    .map(s => ({
      binding: s['@_Binding'],
      location: s['@_Location'],
    }));

  if (singleSignOnService.length === 0) {
    throw new Error('Invalid IdP metadata: no supported SingleSignOnService binding (HTTP-POST or HTTP-Redirect required)');
  }

  // Extract certificates from KeyDescriptor
  const keyDescriptors = idpSsoDescriptor.KeyDescriptor || idpSsoDescriptor['md:KeyDescriptor'] || [];
  const certificates = [];
  for (const kd of keyDescriptors) {
    const use = kd['@_use'];
    if (use && use !== 'signing') continue; // Only signing certificates

    const keyInfo = kd.KeyInfo || kd['ds:KeyInfo'] || kd['xenc:KeyInfo'];
    if (!keyInfo) continue;

    const x509Data = keyInfo.X509Data || keyInfo['ds:X509Data'];
    if (!x509Data) continue;

    const certs = x509Data.X509Certificate || x509Data['ds:X509Certificate'] || [];
    for (const cert of certs) {
      const certText = typeof cert === 'string' ? cert : (cert['#text'] || '');
      if (certText) {
        certificates.push(formatPem(certText.trim()));
      }
    }
  }

  if (certificates.length === 0) {
    throw new Error('Invalid IdP metadata: no signing certificates found');
  }

  // Extract SingleLogoutService
  const sloServices = idpSsoDescriptor.SingleLogoutService || idpSsoDescriptor['md:SingleLogoutService'] || [];
  const singleLogoutService = sloServices.map(s => ({
    binding: s['@_Binding'],
    location: s['@_Location'],
  }));

  return {
    entityID,
    singleSignOnService,
    singleLogoutService: singleLogoutService.length > 0 ? singleLogoutService : null,
    x509Cert: certificates,
  };
}

function formatPem(base64Cert) {
  // Ensure proper PEM format
  const lines = base64Cert.match(/.{1,64}/g) || [base64Cert];
  return `-----BEGIN CERTIFICATE-----\n${lines.join('\n')}\n-----END CERTIFICATE-----`;
}

function verifyCertificateTrust(certPem, trustedCerts) {
  // Extract the raw certificate from PEM
  const certMatch = certPem.match(/-----BEGIN CERTIFICATE-----\n([\s\S]+)\n-----END CERTIFICATE-----/);
  if (!certMatch) return false;
  const certBase64 = certMatch[1].replace(/\s/g, '');

  for (const trusted of trustedCerts) {
    const trustedMatch = trusted.match(/-----BEGIN CERTIFICATE-----\n([\s\S]+)\n-----END CERTIFICATE-----/);
    if (!trustedMatch) continue;
    const trustedBase64 = trustedMatch[1].replace(/\s/g, '');
    if (certBase64 === trustedBase64) return true;
  }
  return false;
}

module.exports = {
  NAMESPACES,
  parseIdPMetadataXml,
  extractMetadata,
  formatPem,
  verifyCertificateTrust,
};