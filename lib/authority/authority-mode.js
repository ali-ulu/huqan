'use strict';

// Which approval authority the runtime answers to (#3860, ADR-016 item 9).
//
//   service               a pin names an authority: decisions need it
//   legacy                no pin: today's same-user behaviour, reported as such
//   required_unavailable  a pin is required or installed but cannot be used
//
// The installed pin's path is fixed, not derived from the environment: an
// agent can change its own environment far more cheaply than it can edit code,
// so no variable may move, hide or replace the installed pin. When that pin
// exists, HUQAN_AUTHORITY_PIN_PATH and HUQAN_APPROVAL_AUTHORITY are ignored;
// they can only add an authority where none is installed, or demand one -- and
// an added one is reported as `env-override`, not as an OS boundary, because
// whoever sets the variable chose it. An installed pin that cannot be read or
// trusted, or an install directory that is a link to somewhere else, fails
// closed rather than falling back to legacy. A planted install directory is
// no link, so before a parsed pin is trusted the live owner and DACL of the
// install directory, the public directory and the pin file are re-checked
// (lib/authority/install-trust.js): anything not owned by
// SYSTEM/Administrators, anything granting write-like rights to a broad
// identity, or a check that cannot run, fails closed as `install_path_untrusted`.

const fs = require('node:fs');
const path = require('node:path');
const { readCompatibleEnvironmentVariable } = require('../environment-compat');
const { parseAuthorityPin } = require('./authority-pin');
const { checkInstallTrust } = require('./install-trust');

const DEFAULT_WINDOWS_INSTALL_DIR = 'C:\\ProgramData\\huqan-authority';
const DEFAULT_WINDOWS_PIN_PATH = path.win32.join(DEFAULT_WINDOWS_INSTALL_DIR, 'public', 'authority.json');
const LEGACY = Object.freeze({ mode: 'legacy', boundary: 'same-user' });

function readPin(pinPath, readFile) {
  let text;
  try {
    text = readFile(pinPath);
  } catch (error) {
    return error && error.code === 'ENOENT' ? { absent: true } : { reason: 'pin_unreadable' };
  }
  const parsed = parseAuthorityPin(text);
  return parsed.ok ? { pin: parsed.pin } : { reason: parsed.reason };
}

/** A junction or symlink anywhere on the installed path could point it at nothing, or at a planted pin. */
function linkedInstallPath(lstat) {
  for (const target of [DEFAULT_WINDOWS_INSTALL_DIR, path.win32.dirname(DEFAULT_WINDOWS_PIN_PATH), DEFAULT_WINDOWS_PIN_PATH]) {
    try {
      if (lstat(target).isSymbolicLink()) return true;
    } catch (error) {
      if (!error || error.code !== 'ENOENT') return true;
    }
  }
  return false;
}

function resolveApprovalAuthorityMode({
  platform = process.platform,
  readEnv = readCompatibleEnvironmentVariable,
  readFile = file => fs.readFileSync(file, 'utf8'),
  lstat = fs.lstatSync,
  checkTrust = checkInstallTrust,
} = {}) {
  if (platform === 'win32') {
    if (linkedInstallPath(lstat)) {
      return { mode: 'required_unavailable', reason: 'install_path_linked', pinPath: DEFAULT_WINDOWS_PIN_PATH };
    }
    const installed = readPin(DEFAULT_WINDOWS_PIN_PATH, readFile);
    if (installed.pin) {
      // The pin parses, but a planted directory parses too. Trust the live
      // owner and DACL, not the file content. Absent pins skip this: with
      // nothing installed there is nothing to trust, so legacy still applies.
      let trusted = false;
      try {
        trusted = checkTrust().ok === true;
      } catch (error) {
        trusted = false;
      }
      if (!trusted) {
        return { mode: 'required_unavailable', reason: 'install_path_untrusted', pinPath: DEFAULT_WINDOWS_PIN_PATH };
      }
      return { mode: 'service', boundary: 'os-service', pinPath: DEFAULT_WINDOWS_PIN_PATH, pin: installed.pin };
    }
    if (!installed.absent) return { mode: 'required_unavailable', reason: installed.reason, pinPath: DEFAULT_WINDOWS_PIN_PATH };
  }
  const overridePath = readEnv('AUTHORITY_PIN_PATH');
  if (overridePath) {
    const override = readPin(overridePath, readFile);
    if (override.pin) return { mode: 'service', boundary: 'env-override', pinPath: overridePath, pin: override.pin };
    return { mode: 'required_unavailable', reason: override.absent ? 'no_pin' : override.reason, pinPath: overridePath };
  }
  if (readEnv('APPROVAL_AUTHORITY') === 'required') return { mode: 'required_unavailable', reason: 'no_pin' };
  return LEGACY;
}

module.exports = { DEFAULT_WINDOWS_INSTALL_DIR, DEFAULT_WINDOWS_PIN_PATH, resolveApprovalAuthorityMode };
