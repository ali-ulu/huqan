'use strict';

// `huqan-authority status`: which authority this runtime answers to, whether the
// pinned service answers, whether agents run as a separate OS user (ADR-017,
// #3948), and -- since ADR-020 (#4082) -- whether the runtime user can escalate
// with passwordless sudo. Extracted from bin/huqan-authority.js so the command
// stays a thin orchestrator and this reporting has one home with its own test.

const { spawnSync } = require('node:child_process');
const { resolveApprovalAuthorityMode } = require('./authority-mode');
const { createAuthorityClient } = require('./authority-client');
const { resolveAgentUserBoundary } = require('./agent-user-boundary');

// ADR-020 section 9: `os-service` is not absolute protection. On POSIX a runtime
// user with passwordless sudo can become root and read the TOTP secret, so the
// boundary is reported as an escalation rather than silently assumed to hold.
// The probe is `sudo -n true`: non-interactive (a password prompt would hang the
// run), read-only, argv fixed in source. A probe that cannot run is `unknown`,
// never a false `none`: "we could not tell" and "there is no sudo" are different
// claims and only one of them is safe to make.
function detectEscalation({ platform = process.platform, run = spawnSync } = {}) {
  if (platform !== 'linux' && platform !== 'darwin') return 'not_applicable';
  const probe = run('sudo', ['-n', 'true'], { stdio: 'ignore', timeout: 5000 });
  if (!probe || probe.error || probe.status === null) return 'unknown';
  return probe.status === 0 ? 'passwordless_sudo' : 'none';
}

function defaults(deps) {
  return { resolveMode: resolveApprovalAuthorityMode, createClient: createAuthorityClient,
    resolveAgentBoundary: resolveAgentUserBoundary, detectEscalation, ...deps };
}

async function status(deps = {}) {
  const { resolveMode, createClient, resolveAgentBoundary, detectEscalation: escalationProbe } = defaults(deps);
  const mode = resolveMode();
  // The agent-user boundary (ADR-017) is orthogonal to the authority boundary:
  // `boundary` names which authority this runtime answers to, `agentBoundary`
  // names whether agents run as a separate OS user. Reporting the second must
  // not overwrite the first, so it is its own field in every mode. `escalation`
  // is a third, orthogonal field for the same reason.
  const agentBoundary = resolveAgentBoundary().value;
  const escalation = escalationProbe();
  if (mode.mode === 'legacy') {
    return { code: 0, report: { mode: 'legacy', boundary: mode.boundary, agentBoundary, escalation,
      note: 'no approval authority is installed; operator decisions are protected only by the same OS user' } };
  }
  if (mode.mode !== 'service') {
    return { code: 2, report: { mode: mode.mode, reason: mode.reason, pinPath: mode.pinPath, agentBoundary, escalation } };
  }
  const base = { mode: 'service', boundary: mode.boundary, agentBoundary, escalation, pinPath: mode.pinPath,
    port: mode.pin.port, keyId: mode.pin.keyId };
  try {
    const identity = await createClient({ pin: mode.pin }).identity();
    // Signed is not enough: the service must answer 200 under the very key the pin names.
    if (identity.status !== 200 || !identity.body || identity.body.keyId !== mode.pin.keyId) {
      return { code: 2, report: { ...base, answering: false, error: 'AUTHORITY_IDENTITY_MISMATCH' } };
    }
    return { code: 0, report: { ...base, answering: true } };
  } catch (error) {
    return { code: 2, report: { ...base, answering: false, error: error.code || 'STATUS_FAILED' } };
  }
}

// The doctor's `authority` check (ADR-020 section 9). It reports, and fails only
// where the boundary is claimed and does not hold: a required authority that is
// unavailable, a pinned service that does not answer, or an `os-service`
// boundary the runtime user can sudo past. Legacy is the documented default, so
// it passes with a note -- the same shape as the egress check.
async function checkAuthority(deps = {}) {
  const { report } = await status(deps);
  if (report.mode === 'legacy') {
    return { ok: true, detail: 'no approval authority installed; decisions are protected only by the same OS user',
      mode: 'legacy', escalation: report.escalation };
  }
  if (report.mode !== 'service') {
    return { ok: false, detail: `required but unavailable (${report.reason})`, mode: report.mode,
      reason: report.reason, escalation: report.escalation };
  }
  if (report.answering !== true) {
    return { ok: false, detail: `the pinned service is not answering (${report.error})`, mode: 'service',
      answering: false, error: report.error, escalation: report.escalation };
  }
  // Only an `os-service` report claims an OS boundary. An `env-override` service
  // answers under a pin the operator supplied and makes no such claim, so a
  // passwordless sudo does not falsify it -- it is still reported, not failed.
  if (report.escalation === 'passwordless_sudo') {
    if (report.boundary === 'os-service') {
      return { ok: false, detail: 'the runtime user can run sudo without a password prompt; the os-service boundary does not hold',
        mode: 'service', boundary: report.boundary, escalation: report.escalation };
    }
    return { ok: true, detail: 'the pinned service answers under an operator-supplied pin; the runtime user can run sudo without a password prompt, which that pin does not claim to prevent',
      mode: 'service', answering: true, boundary: report.boundary, escalation: report.escalation };
  }
  // A failed probe is not a clean pass: a narrow sudoers rule or a cached
  // credential can both hide behind it, so the finding says what was observed
  // rather than that escalation is impossible.
  if (report.escalation === 'unknown') {
    return { ok: true, detail: 'the pinned service answers; the escalation probe could not run, so escalation is unverified',
      mode: 'service', answering: true, boundary: report.boundary, escalation: report.escalation };
  }
  return { ok: true, detail: 'the pinned service answers; the escalation probe found no passwordless sudo',
    mode: 'service', answering: true, boundary: report.boundary, escalation: report.escalation };
}

module.exports = { status, checkAuthority, detectEscalation };
