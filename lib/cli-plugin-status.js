'use strict';

/**
 * The plugin capability report `huqan status` prints (#1694).
 *
 * The loader used to `console.warn` a line per declining plugin on every single
 * command -- five of them on a default install, before the first line of real
 * output, on stderr, including in `--json` runs. The information is worth
 * having; announcing it unprompted is what made a correct default configuration
 * look like a half-broken one.
 *
 * So it lives here instead: silent by default, and reported where a reader is
 * already asking what state the system is in.
 */

function formatPluginCapabilityStatus(pluginManager) {
  if (!pluginManager || typeof pluginManager.capabilitySummary !== 'function') return '';
  const summary = pluginManager.capabilitySummary();
  const lines = [];

  const provenanceByPlugin = new Map(
    (Array.isArray(summary.provenance) ? summary.provenance : []).map(entry => [entry.plugin, entry]),
  );
  if (summary.loaded.length > 0) {
    lines.push(`  Plugins active (${summary.loaded.length}): ${summary.loaded.join(', ')}`);
    // #1890: identity chain per loaded plugin -- version, publisher
    // provenance, and signature status, so a silently upgraded plugin reads
    // differently from the one that was approved.
    for (const name of [...summary.loaded].sort()) {
      const provenance = provenanceByPlugin.get(name);
      if (!provenance) continue;
      lines.push(`  Plugin ${name}: v${provenance.version} by ${provenance.issuer} [${provenance.signatureStatus}]`
        + (provenance.capabilities.length > 0 ? ` (capabilities: ${provenance.capabilities.join(', ')})` : ''));
    }
  }
  for (const item of summary.skipped) {
    // Named as a switch the operator can flip, not as a failure: these plugins
    // are waiting for a capability, and enabling it is the whole fix.
    lines.push(`  Plugin ${item.plugin}: inactive — enable capability '${item.capability}' to use it`);
  }
  for (const item of summary.degraded) {
    lines.push(`  Plugin ${item.plugin}: active, optional capability '${item.capability}' is off`);
  }

  return lines.length > 0 ? `\n${lines.join('\n')}` : '';
}

module.exports = { formatPluginCapabilityStatus };
