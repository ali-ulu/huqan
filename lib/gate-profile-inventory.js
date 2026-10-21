'use strict';

// #4135: which agent gate profiles actually have an installed artifact.
//
// The Usage doctor check needs this to name an installed-but-silent profile.
// It is deliberately a leaf: it reads the install spec and the artifact check,
// and nothing else. Reaching the same answer through the gate CLI's management
// port would fuse the whole gate/adapter closure into every doctor test, which
// is exactly the dependency inflation #2610 measured and pins against.

const os = require('node:os');
const { PROFILES, profileSpec } = require('./external-action-gate-install-spec');
const { installed } = require('./external-action-gate-install-files');

/**
 * @param {object} [options]
 * @param {string} [options.root] project directory the profiles install into
 * @param {string} [options.home] home directory, defaults to the real one
 * @returns {string[]} artifact-backed profile names, in stable PROFILES order
 */
function installedGateProfiles(options = {}) {
  const root = options.root || process.cwd();
  const home = options.home || os.homedir();
  return PROFILES.filter((profile) => installed(profileSpec(profile, root, home), profile));
}

module.exports = { installedGateProfiles };
