'use strict';

const { createHash } = require('node:crypto');
const { types } = require('node:util');
const { isPlainObject } = require('../is-plain-object');
const { round6 } = require('../cognition/contract');
const { MIN_GROUP_SIZE, CONSISTENCY_MIN } = require('../cognition/replay-generalize');
const { countIndependentSources } = require('../cognition/independent-sources');
const { readSealedStringArrayEvidence } = require('./string-array-evidence');
const { validStringArray } = require('./string-array-program');
const { readStringArrayTarget } = require('./string-array-target');

const FAMILY = 'string-array-join';
const sha = value => createHash('sha256').update(value).digest('hex');
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const operationKey = operation => JSON.stringify([operation?.path, operation?.findSha256, operation?.replaceSha256]);

function dataFields(value, keys) {
  if (types.isProxy(value) || !isPlainObject(value) || Reflect.ownKeys(value).length !== keys.length) return false;
  return keys.every(key => {
    const property = Object.getOwnPropertyDescriptor(value, key);
    return property?.enumerable && Object.hasOwn(property, 'value');
  });
}

function validStringArrayReplayParams(params) {
  return dataFields(params, ['family', 'methodHash'])
    && params.family === FAMILY && digest(params.methodHash);
}

function validStringArrayQualification(input) {
  return dataFields(input, ['before', 'binding', 'expected', 'expectedAfter', 'id', 'input'])
    && typeof input.binding === 'string' && validStringArray(input.input)
    && typeof input.expected === 'string' && input.expected.length <= 263168;
}

function readReplayEvidence(journal, sources, workspaceId, methodHash) {
  const positives = new Map();
  const operations = new Map();
  const invalid = new Set();
  for (const [id, source] of sources) {
    const proposed = source.events?.find(event => event.type === 'action_proposed')?.payload;
    if (source.manifest?.learningEligibility !== 'positive_procedure' || !Object.hasOwn(proposed || {}, 'semanticEvidence')) continue;
    const evidence = readSealedStringArrayEvidence(journal, id, workspaceId);
    if (!evidence) { invalid.add(id); continue; }
    if (evidence.methodHash !== methodHash) continue;
    positives.set(id, evidence);
    const key = operationKey(proposed);
    if (!operations.has(key)) operations.set(key, []);
    operations.get(key).push(evidence);
  }
  return { positives, operations, invalid };
}

function matchReplayNegative(source, operations, methodHash) {
  if (source.manifest.learningEligibility !== 'negative_example') return null;
  const proposed = source.events.find(event => event.type === 'action_proposed');
  const routed = source.events.find(event => event.type === 'routing_decided');
  const operation = routed?.payload?.execution ?? proposed?.payload;
  const proposedKey = operationKey(proposed?.payload), executedKey = operationKey(operation);
  const matches = operations.get(executedKey) || [];
  // A method claim can prevent a consistency verdict, but cannot establish a negative.
  if (!matches.length && !operations.has(proposedKey)
    && proposed?.payload?.semanticEvidence?.methodHash !== methodHash) return null;
  const types = ['run_started', 'action_proposed', 'policy_decided', ...(routed ? ['routing_decided'] : []),
    'execution_started', 'execution_finished', 'verification', 'run_closed'];
  const { events } = source;
  if (events.length !== types.length || !events.every((event, index) => event.type === types[index]
    && (index === 0 || event.causedByEventId === events[index - 1].eventId))
    || events[2].payload?.decision !== 'allow') return { reason: 'semantic_negative_binding_unverified' };
  const execution = source.events.find(event => event.type === 'execution_finished');
  const verification = source.events.find(event => event.type === 'verification');
  const change = execution?.payload?.changes?.[0];
  const check = verification?.payload?.checks?.[0];
  if (operation?.operationType !== 'replace_text' || proposedKey !== executedKey
    || !Array.isArray(execution?.payload?.changes) || execution.payload.changes.length !== 1
    || !Array.isArray(verification?.payload?.checks) || verification.payload.checks.length !== 1
    || verification.payload.verified !== false || verification.outcomeStatus !== 'failed'
    || verification.proofs?.failureEvidence !== true || verification.proofs?.permission !== true
    || check?.match !== false || check.path !== operation.path
    || !matches.some(evidence => change?.path === evidence.sourcePin.path
      && change.beforeSha256 === evidence.sourcePin.sha256 && change.afterSha256 === evidence.afterSourceSha256)) {
    return { reason: 'semantic_negative_binding_unverified' };
  }
  return { matched: true };
}

function replayDependencyRefs(source) {
  const refs = new Set([`run:${source.manifest.runId}`]);
  const addArtifact = hash => {
    if (digest(hash)) refs.add(`artifact:${hash}`);
  };
  for (const event of source.events) {
    if (typeof event.parentRunId === 'string' && event.parentRunId.length > 0
      && event.parentRunId.trim() === event.parentRunId) refs.add(`run:${event.parentRunId}`);
    if (event.type === 'execution_finished' && Array.isArray(event.payload?.changes)) {
      for (const change of event.payload.changes) {
        addArtifact(change?.beforeSha256);
        addArtifact(change?.afterSha256);
      }
    }
    if (event.type === 'verification' && Array.isArray(event.payload?.checks)) {
      for (const check of event.payload.checks) addArtifact(check?.actualSha256);
    }
    const bound = event.payload?.boundProcedureVersion;
    if (event.type === 'routing_decided' && digest(bound)) refs.add(`procedure:${bound}`);
  }
  return [...refs];
}

function qualifyStringArrayCandidate(candidate, request, evidence, sourceDigests, episodes, dependencies) {
  if (candidate.candidateKind !== 'procedure') return { reason: 'semantic_positive_support_required' };
  const supportIds = new Set(candidate.support), counterexampleIds = new Set(candidate.counterexamples);
  const support = episodes.filter(episode => supportIds.has(episode.episodeId));
  const counterexamples = episodes.filter(episode => counterexampleIds.has(episode.episodeId));
  const universe = [...dependencies, ...episodes];
  const nIndependent = countIndependentSources(support, universe);
  if (nIndependent < MIN_GROUP_SIZE) return { reason: 'insufficient_independent_consistency' };
  const consistency = Math.min(candidate.consistency,
    nIndependent / (nIndependent + countIndependentSources(counterexamples, universe)));
  if (consistency < CONSISTENCY_MIN) return { reason: 'insufficient_independent_consistency' };

  const { family, methodHash, before, after } = evidence.get(candidate.support[0]);
  const details = [];
  let distinguished = false;
  for (const input of request.qualificationInputs) {
    if ([input.before, input.expectedAfter].some(source => sourceDigests.has(sha(source)))) return { reason: 'qualification_source_overlap' };
    const target = { binding: input.binding, separator: before.separator };
    const original = readStringArrayTarget(input.before, target);
    const changed = readStringArrayTarget(input.expectedAfter, target);
    if (original?.program.type !== before.type || changed?.program.type !== after.type
      || input.before.split(original.find).length !== 2) return { reason: 'qualification_target_mismatch' };
    const rendered = input.before.slice(0, original.expressionStart) + original.instantiate(after)
      + input.before.slice(original.expressionEnd);
    if (rendered !== input.expectedAfter || changed.evaluate(input.input) !== input.expected) return { reason: 'qualification_oracle_mismatch' };
    if (original.evaluate(input.input) !== input.expected) distinguished = true;
    details.push({ id: input.id, passed: true });
  }
  if (!distinguished) return { reason: 'qualification_method_underdetermined' };
  return { candidate: { ...candidate, capabilityId: request.capabilityId, family, methodHash, before, after,
    nIndependent, consistency: round6(consistency), qualification: { ok: true, qualified: true, details } } };
}

module.exports = { validStringArrayReplayParams, validStringArrayQualification, readReplayEvidence,
  matchReplayNegative, replayDependencyRefs, qualifyStringArrayCandidate };
