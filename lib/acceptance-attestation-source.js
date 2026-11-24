'use strict';

/**
 * Where the Coder boundary reads the acceptance attestation, and the key it
 * must verify against (#4624, #4632).
 *
 * `lib/experience/acceptance-attestation.js` judges a parsed envelope and
 * deliberately holds no filesystem and no clock. This module is the I/O half
 * both Coder commands share: `coder propose --source` reads it while creating a
 * task and `coder <task.json>` reads it again at execution. One reader for both
 * means a task edited between the two commands is judged against the same
 * anchor, by the same rule.
 *
 * ## The environment variable is a pointer, not proof
 *
 *   HUQAN_ACCEPTANCE_ATTESTATION   path to the signed acceptance attestation
 *
 * A proposer can set this variable, so it cannot be evidence of anything. It
 * only says where the signed envelope sits. The proof is the envelope's
 * signature against the pinned authority key; an unsigned file at this path, or
 * no pinned key at all, refuses.
 *
 * `HUQAN_ACCEPTANCE_CHANNEL` and `HUQAN_ACCEPTANCE_COMMAND` were the old inputs
 * and are no longer read at all (#4624). A launcher still setting them grants
 * nothing: the oracle check refuses for want of a verified attestation, which is
 * the correct outcome for a self-declared channel.
 */
const fs = require('node:fs');
const { resolveApprovalAuthorityMode } = require('./authority/authority-mode');

const ACCEPTANCE_ENV = Object.freeze({
  ATTESTATION: 'HUQAN_ACCEPTANCE_ATTESTATION',
});

/**
 * The parsed signed attestation, or `null`.
 *
 * A file that does not parse is handed on as `null` and the verifier refuses it
 * as `oracle_supply_unverified`. A malformed attestation must not crash the
 * command: it is the same refusal as no attestation at all.
 */
function readAttestation(environment) {
  const env = environment && typeof environment === 'object' ? environment : process.env;
  const file = env[ACCEPTANCE_ENV.ATTESTATION];
  if (typeof file !== 'string' || !file) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * The pinned signing key the attestation must verify against, or `null`.
 *
 * Only an `os-service` authority counts. `resolveApprovalAuthorityMode` reports
 * three service shapes and they are not equally trustworthy:
 *
 *   os-service    the pin sits on a path the agent user cannot write
 *   env-override  the pin is wherever `HUQAN_AUTHORITY_PIN_PATH` says, i.e.
 *                 wherever the launching process chose -- and the proposing
 *                 agent chooses its own launcher, so it can mint that pin and
 *                 the keypair beside it
 *   legacy        no pin at all
 *
 * Accepting `env-override` here would rebuild the exact hole #4624 is about,
 * one layer down: instead of setting a channel variable the agent would point
 * at its own key. So the boundary has to be the one the OS enforces, and
 * everything else answers `null`, which the verifier refuses.
 *
 * `opts.authorityMode` is the seam the CLI fills from the installed pin. It
 * exists because a child process cannot be handed an OS-boundary pin, so the
 * tests drive the same handler through the same shape the CLI resolves.
 */
function resolveTrustedKey(opts = {}) {
  try {
    const mode = opts.authorityMode || resolveApprovalAuthorityMode();
    if (!mode || mode.mode !== 'service' || mode.boundary !== 'os-service') return null;
    return mode.pin ? mode.pin.signingKey : null;
  } catch (_) {
    return null;
  }
}

module.exports = {
  ACCEPTANCE_ENV,
  readAttestation,
  resolveTrustedKey,
};
