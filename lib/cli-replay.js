'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { isPlainObject } = require('./is-plain-object');
const { openJournalConnection } = require('./experience/journal-connection');
const { createExperienceJournal } = require('./experience/journal');
const { readSealedRun, buildLearningProposal } = require('./experience/learning-intake');
const { qualify } = require('./experience/compiler');
const { computePredictionError } = require('./cognition/prediction-error');
const { computeRewardSignal } = require('./cognition/reward-signal');
const { groupForCandidates } = require('./cognition/replay-generalize');
const { countIndependentSources } = require('./cognition/independent-sources');

const sha = value => createHash('sha256').update(value).digest('hex');
const text = value => typeof value === 'string' && value.length > 0 && value.trim() === value;
const content = value => typeof value === 'string' && value.length > 0;
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function invalid(message) {
  const error = new TypeError(`terfi replay: ${message}`);
  error.code = 'INVALID_REPLAY_REQUEST'; error.exitCode = 2;
  throw error;
}
function flagsFrom(args) {
  if (!Array.isArray(args)) invalid('argv must be an array');
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (Object.hasOwn(flags, name)) invalid(`duplicate flag ${name}`);
    if (['--from-replay', '--dry-run'].includes(name)) { flags[name] = true; continue; }
    if (!['--journal', '--workspace', '--request', '--budget'].includes(name)) invalid(`unknown flag ${name}`);
    const value = args[++i];
    if (!text(value) || value.startsWith('--')) invalid(`missing value for ${name}`);
    flags[name] = value;
  }
  if (!flags['--from-replay'] || !flags['--dry-run']) invalid('--from-replay requires --dry-run');
  for (const name of ['--journal', '--workspace', '--request']) if (!flags[name]) invalid(`${name} is required`);
  if (flags['--budget'] !== undefined && !/^[1-9]\d*$/u.test(flags['--budget'])) invalid('invalid budget');
  return flags;
}
function requestFrom(file) {
  const request = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!isPlainObject(request) || Object.keys(request).some(key => !['capabilityId', 'params', 'parentVersion', 'qualificationInputs'].includes(key))
    || !text(request.capabilityId) || !/^[\w.:-]+$/u.test(request.capabilityId)
    || !isPlainObject(request.params) || Object.keys(request.params).sort().join() !== 'newText,oldText,path'
    || !text(request.params.path) || !content(request.params.oldText) || !content(request.params.newText) || request.parentVersion !== 0
    || !Array.isArray(request.qualificationInputs) || request.qualificationInputs.length === 0) invalid('invalid request or unsupported parent version');
  const ids = new Set();
  for (const input of request.qualificationInputs) {
    if (!isPlainObject(input) || Object.keys(input).sort().join() !== 'before,expectedAfter,id'
      || !text(input.id) || !content(input.before) || !content(input.expectedAfter) || ids.has(input.id)) invalid('invalid qualification input');
    ids.add(input.id);
  }
  return request;
}

function episodeFrom(source, request) {
  const { events, manifest } = source;
  const start = events.find(event => event.type === 'run_started');
  const action = events.find(event => event.type === 'action_proposed');
  const routed = events.find(event => event.type === 'routing_decided');
  const execution = events.find(event => event.type === 'execution_finished');
  const verification = events.find(event => event.type === 'verification');
  const operation = routed?.payload?.execution || action?.payload;
  const { params } = request;
  if (operation?.operationType !== 'replace_text' || operation.path !== params.path
    || operation.findSha256 !== sha(params.oldText) || operation.replaceSha256 !== sha(params.newText)) return { reason: 'source_operation_mismatch' };
  for (const type of ['run_started', 'action_proposed', 'routing_decided', 'execution_finished', 'verification']) {
    if (events.filter(event => event.type === type).length > 1) return { reason: 'native_observation_ambiguous' };
  }
  if (routed && (!digest(routed.payload?.sourceProcedureHash)
    || routed.payload.chosenCapabilityId !== request.capabilityId)) return { reason: 'learned_source_binding_unknown' };
  const changes = execution?.payload?.changes;
  const checks = verification?.payload?.checks;
  const at = start?.payload?.createdAt;
  if (!Number.isFinite(Date.parse(at)) || !Array.isArray(changes) || changes.length === 0
    || !Array.isArray(checks) || checks.length !== changes.length
    || typeof verification.payload.verified !== 'boolean'
    || verification.causedByEventId !== execution.eventId || verification.sequence <= execution.sequence) return { reason: 'native_observation_missing' };
  const expected = new Map();
  for (const change of changes) {
    if (!isPlainObject(change) || !text(change.path) || !digest(change.afterSha256) || expected.has(change.path)) return { reason: 'native_observation_invalid' };
    expected.set(change.path, change.afterSha256);
  }
  const differences = [], artifactRefs = new Set(), paths = new Set();
  for (const check of checks) {
    if (!isPlainObject(check) || !text(check.path) || paths.has(check.path) || !digest(check.actualSha256)
      || !digest(check.expectedSha256) || expected.get(check.path) !== check.expectedSha256
      || check.match !== (check.actualSha256 === check.expectedSha256)) return { reason: 'native_observation_invalid' };
    paths.add(check.path);
    if (!check.match) differences.push(check.path);
    artifactRefs.add(`artifact:${check.actualSha256}`); artifactRefs.add(`artifact:${check.expectedSha256}`);
  }
  if (manifest.learningEligibility === 'positive_procedure' && (differences.length || !verification.payload.verified)) {
    return { reason: 'verification_eligibility_mismatch' };
  }
  const runId = manifest.runId, key = `cap:${request.capabilityId}`;
  const predictionError = computePredictionError({ kind: 'state', decisionId: runId, key, at,
    failure: { status: differences.length ? 'MISMATCH' : 'CONFIRMED', differences }, keyCount: checks.length });
  const reward = computeRewardSignal({ source: 'experience-journal', decisionId: runId, key, at,
    eligibility: manifest.learningEligibility, expected: null });
  if (predictionError.status !== 'MEASURED' || reward.status !== 'MEASURED') return { reason: 'signal_not_measured' };
  const refs = [...artifactRefs].sort();
  if (routed) refs.push(`procedure:${routed.payload.sourceProcedureHash}`);
  return { episode: { episodeId: runId, workspaceId: events[0].workspaceId, key, frameTask: 'replace_text', at,
    sourceGroup: `observed-artifacts:${sha(JSON.stringify([...artifactRefs].sort()))}`, sourceRefs: refs,
    artifactType: 'procedure', predictionError, reward }, observedDigests: checks.map(check => check.actualSha256) };
}

function bindDependencies(episode, sources) {
  const pending = [episode.episodeId], seen = new Set(), refs = new Set(episode.sourceRefs);
  while (pending.length) {
    const id = pending.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const source = sources.get(id);
    if (!source?.ok) return false;
    refs.add(`run:${id}`);
    for (const event of source.events) {
      if (event.parentRunId) pending.push(event.parentRunId);
      if (event.type === 'execution_finished') {
        if (!Array.isArray(event.payload?.changes)) return false;
        for (const change of event.payload.changes) {
          if (!isPlainObject(change) || !digest(change.afterSha256)) return false;
          refs.add(`artifact:${change.afterSha256}`);
        }
      }
      if (event.type === 'routing_decided' && digest(event.payload?.sourceProcedureHash)) refs.add(`procedure:${event.payload.sourceProcedureHash}`);
    }
  }
  episode.sourceRefs = [...refs].sort();
  return true;
}

function compiledCandidate(candidate, request, journal, workspaceId, sourceDigests, episodes) {
  if (candidate.candidateKind !== 'procedure') return { candidate };
  const support = [], byId = new Map(episodes.map(episode => [episode.episodeId, episode]));
  for (const id of candidate.support) {
    const proposed = [...support, id].map(runId => byId.get(runId));
    if (countIndependentSources(proposed, episodes) > support.length) support.push(id);
    // The existing intake accepts one primary run plus at most 32 baselines.
    if (support.length === 33) break;
  }
  const runId = support.pop();
  const proposal = buildLearningProposal(journal, { runId, workspaceId, kind: 'replace_text',
    params: request.params, parentVersion: request.parentVersion, ...(support.length ? { sourceRunIds: support } : {}) });
  if (!proposal.ok || !proposal.procedure) return { reason: proposal.code || proposal.compileCode || 'compile_refused' };
  const procedure = proposal.procedure;
  for (const input of request.qualificationInputs) {
    const after = input.before.replace(procedure.params.oldText, () => procedure.params.newText);
    if ([input.before, input.expectedAfter, after].some(text => sourceDigests.has(sha(text)))) return { reason: 'qualification_source_overlap' };
    if (after !== input.expectedAfter) return { reason: 'qualification_oracle_mismatch' };
  }
  const qualification = qualify({ procedure, inputs: request.qualificationInputs,
    observe: input => input.before,
    apply: (compiled, input) => ({ sites: input.before.split(compiled.params.oldText).length - 1,
      after: input.before.replace(compiled.params.oldText, () => compiled.params.newText) }) });
  if (!qualification.ok || !qualification.qualified) return { reason: qualification.code || 'qualification_refused' };
  return { candidate: { ...candidate, capabilityId: request.capabilityId, procedure, qualification,
    compiledSupport: [runId, ...support],
    proposalHash: proposal.hash, sourceHashes: [proposal.sourceHash, ...proposal.baselineSourceHashes] } };
}

function runReplayCommand(args) {
  const flags = flagsFrom(args), request = requestFrom(flags['--request']);
  const workspaceId = flags['--workspace'], replayedAt = new Date().toISOString();
  const store = openJournalConnection({ dbPath: flags['--journal'], readOnly: true });
  if (!store) invalid('journal is unavailable or cannot be read without writes');
  try {
    const journal = createExperienceJournal({ store, readOnly: true });
    const sources = new Map(), episodes = [], skipped = [], sourceDigests = new Set();
    for (const id of journal.runIds(workspaceId).sort()) {
      const source = readSealedRun(journal, id, workspaceId);
      const at = source.events?.find(event => event.type === 'run_started')?.payload?.createdAt;
      if (source.ok && Date.parse(at) > Date.parse(replayedAt)) {
        skipped.push({ episodeId: id, reason: 'future_episode' }); continue;
      }
      sources.set(id, source);
    }
    for (const [id, source] of sources) {
      if (!source.ok) { skipped.push({ episodeId: id, reason: source.code }); continue; }
      for (const event of source.events) if (event.type === 'verification' && Array.isArray(event.payload?.checks)) {
        for (const check of event.payload.checks) if (digest(check?.actualSha256)) sourceDigests.add(check.actualSha256);
      }
      const parsed = episodeFrom(source, request);
      if (['native_observation_invalid', 'native_observation_ambiguous', 'verification_eligibility_mismatch'].includes(parsed.reason)) invalid(`${id}: ${parsed.reason}`);
      if (!parsed.episode || !bindDependencies(parsed.episode, sources)) {
        skipped.push({ episodeId: id, reason: parsed.reason || 'source_dependency_unavailable' }); continue;
      }
      parsed.observedDigests.forEach(value => sourceDigests.add(value));
      episodes.push(parsed.episode);
    }
    const grouped = groupForCandidates(episodes, { workspaceId, replayedAt,
      ...(flags['--budget'] ? { budget: Number(flags['--budget']) } : {}) });
    if (grouped.status === 'REJECT') invalid(grouped.reason);
    const candidates = [], rejectedCandidates = [];
    for (const candidate of grouped.candidates) {
      const compiled = compiledCandidate(candidate, request, journal, workspaceId, sourceDigests, episodes);
      if (compiled.candidate) candidates.push(compiled.candidate);
      else rejectedCandidates.push({ key: candidate.key, reason: compiled.reason });
    }
    const selected = new Set(grouped.selected.map(row => row.episodeId));
    return { ...grouped, candidates, rejectedCandidates, skipped: [...skipped, ...grouped.skipped],
      signals: episodes.filter(row => selected.has(row.episodeId)).map(row => ({ episodeId: row.episodeId,
        predictionError: row.predictionError, reward: row.reward, timeSource: 'run_started' })),
      assertsGain: false, registered: false, authority: 'CANDIDATE_ONLY' };
  } finally { store.close(); }
}

function runCliArgv(argv, io, deps) {
  return require('./cli-workflow-adapter').runCliArgv(argv, io, { ...deps, runReplayCommand });
}

module.exports = { runReplayCommand, runCliArgv };
