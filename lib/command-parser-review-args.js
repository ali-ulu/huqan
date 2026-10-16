'use strict';

/**
 * Flag parsing for the `review` sub-commands of `hypotheses` and `conflicts`
 * (#3187).
 *
 * Split out of lib/command-parser.js when the conflict review's stricter
 * operand handling pushed that file over the 400-line threshold. The two
 * parsers sit together because they are the same shape -- tokenise the payload
 * after the command word, then read the flags out of it -- and because the one
 * place they differ is deliberate and worth seeing side by side.
 */

function tokenize(raw) {
  return String(raw || '').trim().split(/\s+/).filter(Boolean);
}

function parseHypothesesArgs(raw) {
  const parts = tokenize(raw);
  const readFlag = (...names) => {
    for (const name of names) {
      const index = parts.indexOf(`--${name}`);
      if (index >= 0) return parts[index + 1] || '';
    }
    return '';
  };
  const base = {
    workspaceId: readFlag('workspaceId', 'workspace', 'w') || 'default',
    confidenceFloor: readFlag('confidenceFloor'),
    criticalInDegree: readFlag('critical'),
    smallComponentSize: readFlag('small'),
    propose: parts.includes('--propose'),
    json: parts.includes('--json'),
  };

  // `hypotheses feedback` reports what the recorded verdicts add up to per
  // rule. Read-only, like the bare report, and parsed as its own shape so it
  // never reaches the analysis path with a rule-report's thresholds applied.
  if (parts[0] === 'feedback' || parts[0] === 'geribildirim') return { ...base, feedback: true };

  // `hypotheses tuning` turns that feedback into a threshold proposal. Also
  // read-only: it advises, and applying the advice stays a human act.
  if (parts[0] === 'tuning' || parts[0] === 'ayar') {
    return { ...base, tuning: true, apply: parts.includes('--apply') || parts.includes('--uygula') };
  }

  // `hypotheses fitness` scores graph health. Read-only: it measures, and
  // acting on the measurement is not this command's job.
  if (parts[0] === 'fitness' || parts[0] === 'saglik') return { ...base, fitness: true, record: parts.includes('--record') };

  // `hypotheses review <candidateId> --accept|--reject` records a human
  // verdict on a queued candidate. It is the only sub-command here that
  // writes, and it is parsed as a distinct shape so the read-only report path
  // cannot be reached with review arguments still attached.
  if (parts[0] !== 'review' && parts[0] !== 'incele') return base;
  const decision = parts.includes('--accept') || parts.includes('--kabul')
    ? 'accept'
    : parts.includes('--reject') || parts.includes('--ret')
      ? 'reject'
      : '';
  return {
    ...base,
    review: true,
    candidateId: parts[1] && !parts[1].startsWith('--') ? parts[1] : '',
    decision,
    reviewer: readFlag('reviewer', 'reviewedBy'),
  };
}

/** `conflicts review <candidateId> --accept|--reject [--reviewer <id>] [--workspace <id>]`.
 * The sibling of `hypotheses review`: it records a human verdict on a queued
 * *conflict* candidate (lib/conflict-detector.js), whose status values and
 * no-canonical-write posture are the same contract (#3187). Parsed as its own
 * shape so the conflict-review path cannot be reached with a rule-report's
 * thresholds attached. */
function parseConflictReviewArgs(raw) {
  const parts = tokenize(raw);
  // A flag's operand is the next token, but only when it is an operand: a
  // following `--flag` means the operand was omitted, and `--reviewer --accept`
  // must not silently record `--accept` as the reviewer's name (#3187 review).
  const readFlag = (...names) => {
    for (const name of names) {
      const index = parts.indexOf(`--${name}`);
      if (index < 0) continue;
      const value = parts[index + 1];
      if (value === undefined || value.startsWith('-')) return '';
      return value;
    }
    return '';
  };
  if (parts[0] !== 'review' && parts[0] !== 'incele') return null;
  // Exactly one decision group: with both `--accept` and `--reject` present the
  // verdict is ambiguous, so it is refused (decision '') rather than resolved in
  // favour of accept, which a later correction could not undo.
  const wantsAccept = parts.includes('--accept') || parts.includes('--kabul');
  const wantsReject = parts.includes('--reject') || parts.includes('--ret');
  const decision = wantsAccept === wantsReject ? '' : wantsAccept ? 'accept' : 'reject';
  return {
    review: true,
    workspaceId: readFlag('workspaceId', 'workspace', 'w') || 'default',
    candidateId: parts[1] && !parts[1].startsWith('--') ? parts[1] : '',
    decision,
    reviewer: readFlag('reviewer', 'reviewedBy'),
  };
}

module.exports = {
  parseHypothesesArgs,
  parseConflictReviewArgs,
};
