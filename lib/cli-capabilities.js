// The capabilities a CLI company/product command switches on before it runs
// (CLI#_ensureCompanyCapabilities / _ensureProductCapabilities in cli.js).
function ensureCompanyCapabilities(kernel, pluginsDir) {
  if (typeof kernel.hasCapability === 'function' && !kernel.hasCapability('companyMode')) {
    kernel.enableCapability('companyMode');
  }
  if (typeof kernel.hasCapability === 'function' && !kernel.hasCapability('pluginCapabilities')) {
    kernel.enableCapability('pluginCapabilities');
  }
  if (kernel.plugins && typeof kernel.plugins.load === 'function') {
    kernel.plugins.load(pluginsDir);
  }
}

function ensureProductCapabilities(kernel, pluginsDir) {
  if (typeof kernel.hasCapability === 'function' && !kernel.hasCapability('pluginCapabilities')) {
    kernel.enableCapability('pluginCapabilities');
  }
  if (typeof kernel.hasCapability === 'function' && !kernel.hasCapability('companyMode')) {
    kernel.enableCapability('companyMode');
  }
  if (typeof kernel.hasCapability === 'function' && !kernel.hasCapability('temporal')) {
    kernel.enableCapability('temporal');
  }
  if (typeof kernel.hasCapability === 'function' && !kernel.hasCapability('evidenceRanking')) {
    kernel.enableCapability('evidenceRanking');
  }
  if (kernel.plugins && typeof kernel.plugins.load === 'function') {
    kernel.plugins.load(pluginsDir);
  }
}

module.exports = { ensureCompanyCapabilities, ensureProductCapabilities };
