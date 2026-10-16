// Capability and provenance records PluginManager (plugin.js) derives from a
// plugin descriptor and its verification.
function normalizedCapabilityNames(value) {
  if (!Array.isArray(value)) return null;
  const names = value.map(item => typeof item === 'string' ? item : item?.name);
  if (names.some(name => typeof name !== 'string' || !name.trim())) return null;
  return [...new Set(names.map(name => name.trim()))].sort();
}

function pluginComponent(plugin, verification) {
  const manifest = verification.manifest || {};
  return { componentType: 'plugin', name: plugin.name, version: manifest.version,
    contentHash: verification.sha256, issuer: manifest.issuer, workspaceId: manifest.workspaceId,
    capabilities: normalizedCapabilityNames(manifest.capabilities)
      || normalizedCapabilityNames(plugin.capabilities) || [], expiresAt: manifest.expiresAt };
}

/**
 * Provenance entry for the registry (#1890): signature status, publisher
 * provenance (issuer), version, content hash, granted capabilities, and
 * declared plugin-to-plugin dependencies. Programmatic plugins carry no
 * verification, so their origin is recorded explicitly as unverified rather
 * than inheriting trust they never presented.
 */
function provenanceEntryFor(plugin, verification) {
  const manifest = (verification && verification.manifest) || {};
  const manifestValue = name => typeof manifest[name] === 'string' && manifest[name].trim() ? manifest[name].trim() : '';
  const declared = normalizedCapabilityNames(manifest.capabilities)
    || normalizedCapabilityNames(plugin.capabilities) || [];
  const rawDeps = Array.isArray(plugin.dependsOn) ? plugin.dependsOn : [];
  return {
    name: plugin.name,
    version: manifestValue('version') || (typeof plugin.version === 'string' && plugin.version.trim() ? plugin.version.trim() : ''),
    issuer: manifestValue('issuer') || (typeof plugin.issuer === 'string' && plugin.issuer.trim() ? plugin.issuer.trim() : ''),
    workspaceId: manifestValue('workspaceId'),
    signatureStatus: verification ? verification.status : 'unverified',
    contentHash: (verification && verification.sha256) || '',
    capabilities: declared,
    dependencies: rawDeps,
    filePath: (verification && verification.filePath) || '',
  };
}

module.exports = { normalizedCapabilityNames, pluginComponent, provenanceEntryFor };
