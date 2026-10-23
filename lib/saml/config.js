'use strict';

const fs = require('node:fs');
const { readCompatibleEnvironmentVariable } = require('../environment-compat');

const SAML_METADATA_ENV = 'SAML_IDP_METADATA_PATH';
const SAML_ENTITY_ID_ENV = 'SAML_SP_ENTITY_ID';
const SAML_ACS_PATH_ENV = 'SAML_SP_ACS_PATH';

const POLICY_VERSION = 1;
const REQUIRED_METADATA_FIELDS = Object.freeze(['entityID', 'singleSignOnService', 'x509Cert']);

/**
 * @returns {{configured: false, ok: true} | {configured: true, ok: false, reason: string} | {configured: true, ok: true, config: object}}
 */
function loadSamlSpConfig({ readEnvironment = readCompatibleEnvironmentVariable, readFile = fs.readFileSync } = {}) {
  const metadataFile = readEnvironment(SAML_METADATA_ENV);
  if (metadataFile === undefined || metadataFile === null || metadataFile === '') {
    return { configured: false, ok: true };
  }

  let metadata;
  try {
    metadata = JSON.parse(readFile(metadataFile, 'utf8'));
  } catch (error) {
    return { configured: true, ok: false, reason: `SAML IdP metadata ${metadataFile} is unreadable: ${error.message}` };
  }

  // Validate required metadata fields
  for (const field of REQUIRED_METADATA_FIELDS) {
    if (!metadata[field]) {
      return { configured: true, ok: false, reason: `SAML IdP metadata missing required field: ${field}` };
    }
  }

  const entityId = readEnvironment(SAML_ENTITY_ID_ENV);
  if (!entityId) {
    return { configured: true, ok: false, reason: 'SAML SP Entity ID (HUQAN_SAML_SP_ENTITY_ID) must be configured when SAML is enabled' };
  }

  const acsPath = readEnvironment(SAML_ACS_PATH_ENV) || '/saml/acs';
  // The ACS URL is what the assertion's Destination/Recipient must match. The
  // SP derives it from the configured path plus the SP Entity ID's origin, so
  // an operator never has to configure the same value twice. An explicit
  // override remains available for reverse-proxy deployments where the public
  // URL differs from the bind address.
  const explicitAcsUrl = readEnvironment('SAML_SP_ACS_URL');
  let acsUrl;
  if (explicitAcsUrl) {
    acsUrl = String(explicitAcsUrl);
  } else {
    try {
      acsUrl = new URL(acsPath, entityId).toString();
    } catch {
      return { configured: true, ok: false, reason: `SAML SP Entity ID ${entityId} is not a valid absolute URL to derive the ACS endpoint from` };
    }
  }

  return {
    configured: true,
    ok: true,
    config: Object.freeze({
      version: POLICY_VERSION,
      entityId,
      acsPath,
      acsUrl,
      metadata: Object.freeze({
        entityID: metadata.entityID,
        singleSignOnService: metadata.singleSignOnService,
        x509Cert: metadata.x509Cert,
        singleLogoutService: metadata.singleLogoutService || null,
      }),
    }),
  };
}

module.exports = {
  SAML_METADATA_ENV,
  SAML_ENTITY_ID_ENV,
  SAML_ACS_PATH_ENV,
  loadSamlSpConfig,
};