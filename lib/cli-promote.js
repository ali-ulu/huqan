'use strict';

// The CLI `terfi` command (#3550, I5 follow-up) -- the first real promotion
// caller for the reflective loop (lib/experience/reflective-promotion.js).
//
//   terfi --aday <candidate.json> --bagli <bound.json> --deneme <runs.json>
//     --gozlem <runs.json> --onaylayan <operator-id> --karar approved|rejected
//     --capability <id> [--geri-alma approved|rejected] [...]
//
// One invocation drives the whole loop in-process from files: propose (with
// the #3551 derived authority check) -> canary over measured runs -> the
// operator's own bound approval -> promote -> observe -> rollback on drift.
// The trust ladder and the admission registry are caller-held and live only
// for this run, so no cross-process state is invented here; the durable
// inputs (candidate, bound version, measured runs) arrive as files and every
// move leaves a receipt the output prints.
//
// The approver is the operator running the command, never the learner: an
// --onaylayan that names a learner principal is refused by the loop itself
// (self_authorization_refused), and the acceptance test pins exactly that.
//
// The admission registry refuses any approver its host cannot vouch for
// (#3552). This command's authentication boundary is the OS session running
// it, so the only approver it vouches for is that session's own user; any
// other --onaylayan is refused as unverified_approver before a record exists.

const fs = require('node:fs');
const os = require('node:os');
const { createPromotionAdmissionRegistry } = require('./experience/canary');
const { createCapabilityTrustRegistry } = require('./experience/capability-trust');
const { createReflectivePromotion, ARTIFACT_TYPES } = require('./experience/reflective-promotion');
const { commandFailure } = require('./cli-helpers');

const PROMOTION_ID = 'terfi-promotion';
const ROLLBACK_ID = 'terfi-rollback';

function cliError(message, exitCode = 1) {
  const error = new Error(message);
  error.exitCode = exitCode;
  return error;
}

function currentSessionUser() {
  try {
    return os.userInfo().username || '';
  } catch (_) {
    return '';
  }
}

// An unknown session user vouches for nobody: fail-closed, like the registry's
// own default resolver.
function sessionPrincipalResolver(sessionUser = currentSessionUser()) {
  return (reference) => (sessionUser && reference === sessionUser
    ? { ok: true, principal: { id: reference, kind: 'os_session_user' } }
    : { ok: false, code: 'approver_not_session_user' });
}

function toTokens(args) {
  if (Array.isArray(args)) return args.map(String).filter(Boolean);
  return String(args || '').trim().split(/\s+/u).filter(Boolean);
}

// Flag table, not a branch chain (same shape as the coder command's table).
const FLAG_DEFS = Object.freeze([
  { flag: '--aday', takesValue: true, apply: (flags, value) => { flags.candidateFile = value || ''; } },
  { flag: '--bagli', takesValue: true, apply: (flags, value) => { flags.boundFile = value || ''; } },
  { flag: '--deneme', takesValue: true, apply: (flags, value) => { flags.trialFile = value || ''; } },
  { flag: '--gozlem', takesValue: true, apply: (flags, value) => { flags.observeFile = value || ''; } },
  { flag: '--onaylayan', takesValue: true, apply: (flags, value) => { flags.approverId = value || ''; } },
  { flag: '--karar', takesValue: true, apply: (flags, value) => { flags.decision = value || ''; } },
  { flag: '--geri-alma', takesValue: true, apply: (flags, value) => { flags.rollbackDecision = value || ''; } },
  { flag: '--ogreniciler', takesValue: true, apply: (flags, value) => { flags.learnerPrincipals = value || ''; } },
  { flag: '--onerici', takesValue: true, apply: (flags, value) => { flags.proposedBy = value || ''; } },
  { flag: '--workspace', takesValue: true, apply: (flags, value) => { flags.workspaceId = value || ''; } },
  { flag: '--capability', takesValue: true, apply: (flags, value) => { flags.capabilityId = value || ''; } },
  { flag: '--tur', takesValue: true, apply: (flags, value) => { flags.artifactType = value || ''; } },
  { flag: '--beyan', takesValue: true, apply: (flags, value) => { flags.declaration = value || ''; } },
  { flag: '--json', takesValue: false, apply: () => {} },
]);
const FLAGS_BY_NAME = Object.freeze(Object.fromEntries(FLAG_DEFS.map((def) => [def.flag, def])));

const USAGE = 'Usage: terfi --aday <candidate.json> --bagli <bound.json> --deneme <runs.json> --gozlem <runs.json> --onaylayan <operator-id> --karar approved|rejected --capability <id> [--geri-alma approved|rejected] [--ogreniciler a,b] [--onerici id] [--workspace ws] [--tur procedure|rule|model] [--beyan {...}]';

function parseFlags(args) {
  const flags = { rollbackDecision: 'rejected', learnerPrincipals: 'learner-agent', proposedBy: 'learner-agent',
    workspaceId: 'default', capabilityId: '', artifactType: 'procedure', declaration: '{}', decision: '' };
  const tokens = toTokens(args);
  for (let i = 0; i < tokens.length; i += 1) {
    const def = FLAGS_BY_NAME[tokens[i]];
    if (!def) throw cliError(`${USAGE}\nterfi: unknown flag ${tokens[i]}`, 2);
    if (def.takesValue) {
      i += 1;
      def.apply(flags, tokens[i] || '');
    } else def.apply(flags);
  }
  const required = { candidateFile: '--aday', boundFile: '--bagli', trialFile: '--deneme', observeFile: '--gozlem', approverId: '--onaylayan', capabilityId: '--capability' };
  for (const [field, flag] of Object.entries(required)) {
    if (!flags[field]) throw cliError(`${USAGE}\nterfi: ${flag} is required`, 2);
  }
  if (flags.decision !== 'approved' && flags.decision !== 'rejected') throw cliError(`${USAGE}\nterfi: --karar must be approved or rejected`, 2);
  if (flags.rollbackDecision !== 'approved' && flags.rollbackDecision !== 'rejected') {
    throw cliError(`${USAGE}\nterfi: --geri-alma must be approved or rejected`, 2);
  }
  if (!ARTIFACT_TYPES.includes(flags.artifactType)) throw cliError(`${USAGE}\nterfi: --tur must be procedure, rule or model`, 2);
  return flags;
}

function readJson(file, label) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (_) {
    throw cliError(`terfi: cannot read ${label} file ${file}`, 2);
  }
  try {
    return JSON.parse(text);
  } catch (_) {
    throw cliError(`terfi: ${label} file ${file} is not JSON`, 2);
  }
}

function runPromoteCommand(cli, args, opts = {}) {
  const flags = parseFlags(args);
  const candidate = readJson(flags.candidateFile, 'aday');
  const bound = readJson(flags.boundFile, 'bagli');
  const trial = readJson(flags.trialFile, 'deneme');
  const observed = readJson(flags.observeFile, 'gozlem');
  let authorityDelta = {};
  try {
    authorityDelta = JSON.parse(flags.declaration);
  } catch (_) {
    throw cliError('terfi: --beyan is not JSON', 2);
  }
  if (!candidate || typeof candidate.version !== 'string' || !candidate.version) throw cliError('terfi: aday file needs a string version', 2);
  if (!bound || typeof bound.version !== 'string' || !bound.version) throw cliError('terfi: bagli file needs a string version', 2);

  const learnerPrincipals = String(flags.learnerPrincipals).split(',').map((s) => s.trim()).filter(Boolean);
  const trust = createCapabilityTrustRegistry();
  trust.createCapability({ workspaceId: flags.workspaceId, capabilityId: flags.capabilityId, boundProcedureVersion: bound.version });
  // The rollback leg refuses an unknown prior version. The trial file's
  // baseline runs ARE the bound version's measured runs, so they are
  // recorded as its evidence; nothing is invented.
  for (const run of Array.isArray(trial.baselineWindowRuns) ? trial.baselineWindowRuns : []) {
    trust.recordRun({ workspaceId: flags.workspaceId, capabilityId: flags.capabilityId, procedureVersion: bound.version,
      eventId: run.eventId, runId: run.runId, learningEligibility: run.learningEligibility, occurredAt: run.occurredAt });
  }
  const admissions = createPromotionAdmissionRegistry({ resolvePrincipal: sessionPrincipalResolver() });
  const loop = createReflectivePromotion({ trust, admissions, learnerPrincipals });
  const steps = [];

  const proposal = loop.propose({ workspaceId: flags.workspaceId, capabilityId: flags.capabilityId, artifactType: flags.artifactType,
    candidateVersion: candidate.version, proposedBy: flags.proposedBy, authorityDelta,
    candidateArtifact: candidate, boundArtifact: bound });
  steps.push({ step: 'proposed', ok: proposal.ok === true, code: proposal.code || null, candidateId: proposal.candidateId || null });
  let promotedEntry = null;
  let rolledEntry = null;
  if (proposal.ok === true) {
    const canary = loop.evaluateCanary({ candidateId: proposal.candidateId, candidateRuns: trial.candidateRuns,
      baselineWindowRuns: trial.baselineWindowRuns, startAt: trial.startAt });
    steps.push({ step: 'canary', ok: canary.ok === true, state: canary.state || canary.code || null });
    if (canary.ok === true && canary.state === 'canary_passed' && flags.decision === 'approved') {
      const recorded = admissions.recordExplicitApproval({ workspaceId: flags.workspaceId, capabilityId: flags.capabilityId,
        promotionId: PROMOTION_ID, approverId: flags.approverId, subject: { kind: 'promotion', candidateVersion: candidate.version } });
      if (!recorded.ok) throw cliError(`terfi: approval could not be recorded (${recorded.code || 'unknown'})`);
      const promoted = loop.promote({ candidateId: proposal.candidateId, promotionId: PROMOTION_ID });
      steps.push({ step: 'promoted', ok: promoted.ok === true, code: promoted.code || null });
      promotedEntry = promoted.entry || null;
      if (promoted.ok === true) {
        const seen = loop.observe({ candidateId: proposal.candidateId, currentEvents: observed.currentEvents || [] });
        steps.push({ step: 'observed', ok: seen.ok === true, driftDetected: seen.driftDetected === true });
        if (seen.ok === true && seen.driftDetected === true && flags.rollbackDecision === 'approved') {
          const recordedRollback = admissions.recordExplicitApproval({ workspaceId: flags.workspaceId, capabilityId: flags.capabilityId,
            promotionId: ROLLBACK_ID, approverId: flags.approverId, subject: { kind: 'rollback', candidateVersion: candidate.version } });
          if (!recordedRollback.ok) throw cliError(`terfi: rollback approval could not be recorded (${recordedRollback.code || 'unknown'})`);
          const rolled = loop.rollback({ candidateId: proposal.candidateId, promotionId: ROLLBACK_ID });
          steps.push({ step: 'rolled_back', ok: rolled.ok === true, code: rolled.code || null });
          rolledEntry = rolled.entry || null;
        }
      }
    } else if (canary.ok === true) {
      steps.push({ step: 'promoted', ok: false, code: flags.decision === 'approved' ? (canary.state || 'canary_not_passed') : 'promotion_declined_by_operator' });
    }
  }

  const receiptReference = (promotedEntry && (promotedEntry.receiptId || promotedEntry.receipt)) || (rolledEntry && (rolledEntry.receiptId || rolledEntry.receipt)) || null;
  const warning = cli && typeof cli.commitCliMutation === 'function'
    ? cli.commitCliMutation('terfi', null, { workspaceId: flags.workspaceId, operatorReason: `approver ${flags.approverId}`, receiptReference }) : '';
  if (opts.json) return JSON.stringify({ ok: true, steps, warning: warning || undefined });
  const lines = steps.map((s) => `terfi ${s.step}: ${s.ok ? 'ok' : `refused (${s.code || s.state})`}${s.candidateId ? ` ${s.candidateId}` : ''}`);
  return `${lines.join('\n')}${warning}`;
}

module.exports = { runPromoteCommand, sessionPrincipalResolver, PROMOTION_ID, ROLLBACK_ID };
