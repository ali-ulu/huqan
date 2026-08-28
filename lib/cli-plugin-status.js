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

  if (summary.loaded.length > 0) {
    lines.push(`  Plugins active (${summary.loaded.length}): ${summary.loaded.join(', ')}`);
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
