'use strict';
const { isDeepStrictEqual } = require('node:util');
const { isPlainObject } = require('./is-plain-object');
const { CONTRACT, bootstrapInterval } = require('./cognitive-lab-b4-evaluator');
const { freezeResult } = require('./cognition/contract');

const text = value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 256;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length
  && keys.every(key => Object.hasOwn(value, key));
const ids = values => Array.isArray(values) && values.length <= 32 && values.every(text) && new Set(values).size === values.length;
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const finish = (status, reason, details = {}) => freezeResult({ status, reason, ...details,
  assertsGain: false, registered: false, authority: 'CANDIDATE_ONLY', intelligenceGain: 'NOT_MEASURED' });

// Raw mathematical diagnostics never certify the caller's native evidence or corpus independence.
function evaluateM3Families(input) {
  if (!exact(input, ['contract', 'records', 'comparisons']) || !isDeepStrictEqual(input.contract, CONTRACT)
    || !Array.isArray(input.records) || !Array.isArray(input.comparisons)) return finish('REJECT', 'invalid_request');
  const { records, comparisons } = input;
  if (records.some(row => ['A1', 'A2'].some(arm => row?.[arm]?.wrongWrite === 1
    || (Array.isArray(row?.[arm]?.violations) && row[arm].violations.length)))) return finish('REJECT', 'trust_violation');
  const families = new Map(), taskIds = new Set();
  for (const comparison of comparisons) {
    if (!exact(comparison, ['familyId', 'budget', 'sourceSnapshotHash', 'dependencyHash', 'cutoff', 'A1', 'A2'])
      || !text(comparison.familyId) || families.has(comparison.familyId) || comparison.budget !== 32
      || !digest(comparison.sourceSnapshotHash) || !digest(comparison.dependencyHash)
      || typeof comparison.cutoff !== 'string' || !Number.isFinite(Date.parse(comparison.cutoff))
      || !ids(comparison.A1) || !ids(comparison.A2) || comparison.A1.length !== comparison.A2.length)
      return finish('REJECT', 'invalid_comparison');
    families.set(comparison.familyId, { comparison, holdout: [], transfer: [] });
  }
  for (const row of records) {
    if (!exact(row, ['taskId', 'familyId', 'split', 'A1', 'A2']) || !text(row.taskId) || taskIds.has(row.taskId)
      || !families.has(row.familyId) || !['holdout', 'transfer'].includes(row.split)
      || ['A1', 'A2'].some(arm => !exact(row[arm], ['correct', 'wrongWrite', 'violations'])
        || ![0, 1].includes(row[arm].correct) || row[arm].wrongWrite !== 0
        || !Array.isArray(row[arm].violations) || row[arm].violations.length)) return finish('REJECT', 'invalid_record');
    taskIds.add(row.taskId);
    families.get(row.familyId)[row.split].push(row.A2.correct - row.A1.correct);
  }
  const ordered = [...families].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  const holdout = ordered.filter(([, family]) => family.holdout.length).map(([, family]) => mean(family.holdout));
  const transfer = ordered.filter(([, family]) => family.transfer.length).map(([, family]) => mean(family.transfer));
  const counts = { holdoutFamilies: holdout.length, transferFamilies: transfer.length };
  if (holdout.length < CONTRACT.minimumSamples || transfer.length < CONTRACT.minimumTransfer)
    return finish('INSUFFICIENT', 'sample_below_minimum', counts);
  if (ordered.filter(([, family]) => family.holdout.length)
    .every(([, family]) => isDeepStrictEqual([...family.comparison.A1].sort(), [...family.comparison.A2].sort())))
    return finish('INSUFFICIENT', 'selection_inert', counts);
  const primary = { mean: mean(holdout), interval: bootstrapInterval(holdout, CONTRACT) };
  return finish('MEASURED', 'family_paired_diagnostic', { ...counts, primary,
    transfer: { mean: mean(transfer), interval: bootstrapInterval(transfer, CONTRACT) },
    clearsEffect: primary.interval.lower > CONTRACT.meaningfulEffect });
}

module.exports = { evaluateM3Families };
