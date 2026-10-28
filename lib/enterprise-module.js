'use strict';

// The paths in LICENSE-ENTERPRISE (SSO, SIEM export, evidence pack) may be
// absent from a core-only deployment. Core loads them only when their feature
// is used, through this one function, and treats "not shipped" as null rather
// than crashing at startup. A file that is present but broken still throws:
// only a missing module is absorbed.

const ENTERPRISE_MISSING_CODE = 'ENTERPRISE_MODULE_MISSING';

// The only modules core may load this way. lib/module-reachability.js walks
// them as entry points, since a static require graph cannot see this load.
const ENTERPRISE_ENTRY_POINTS = Object.freeze([
  'lib/evidence-pack/collect.js',
  'lib/evidence-pack/verify.js',
  'lib/oidc/mount.js',
  'lib/saml/sp-route.js',
  'lib/siem/siem-export-command.js',
]);

/**
 * @param {string} id module id relative to lib/ (e.g. './saml/sp-route')
 * @returns {object|null} the module, or null when the file is not shipped
 */
function loadEnterpriseModule(id) {
  if (!ENTERPRISE_ENTRY_POINTS.includes(`lib/${String(id).replace(/^\.\//, '')}.js`)) {
    throw new Error(`not an enterprise entry point: ${id}`);
  }
  let resolved;
  try {
    resolved = require.resolve(id);
  } catch (error) {
    if (error && error.code === 'MODULE_NOT_FOUND') return null;
    throw error;
  }
  return require(resolved);
}

function enterpriseMissingMessage(feature) {
  return `${feature} is a HUQAN Enterprise feature and its files are not installed (see LICENSE-ENTERPRISE).`;
}

module.exports = { ENTERPRISE_ENTRY_POINTS, ENTERPRISE_MISSING_CODE, enterpriseMissingMessage, loadEnterpriseModule };
