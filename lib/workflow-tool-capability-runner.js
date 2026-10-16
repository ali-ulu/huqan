'use strict';

// Which capability runner a workflow tool reaches, and how its refusals read (#2133).

function resolveCapabilityRunner(kernel) {
  if (kernel && typeof kernel.runCapability === 'function') {
    return {
      source: 'kernel.runCapability',
      run: kernel.runCapability.bind(kernel),
    };
  }
  if (kernel && kernel.plugins && typeof kernel.plugins.runCapability === 'function') {
    return {
      source: 'plugin-manager',
      run: kernel.plugins.runCapability.bind(kernel.plugins),
    };
  }
  return null;
}

function getCapabilityMetadata(kernel, name) {
  if (kernel && typeof kernel.getCapability === 'function') return kernel.getCapability(name);
  if (kernel && kernel.plugins && typeof kernel.plugins.getCapability === 'function') {
    return kernel.plugins.getCapability(name);
  }
  return null;
}

function isUnavailableCapabilityError(error) {
  const message = String(error?.message || error || '');
  return /missing capability|unavailable|unknown plugin capability|unknown capability/i.test(message);
}

module.exports = {
  resolveCapabilityRunner,
  getCapabilityMetadata,
  isUnavailableCapabilityError,
};
