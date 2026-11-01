'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { stableStringify, sha256Hex } = require('./hash-chain');
const { isPlainObject } = require('./is-plain-object');
const { readReplayRequest } = require('./cognitive-lab-request-reader');
const { runReplayComparison } = require('./cli-replay');
const { openJournalConnection } = require('./experience/journal-connection');
const { createExperienceJournal } = require('./experience/journal');
const { readSealedRun } = require('./experience/learning-intake');
const { readOrdinaryAcceptance } = require('./agent-coder-project-task');
const { evaluateM3Families } = require('./cognitive-lab-m3-evaluator');

// Canonical UTF-8/LF protocol document; source integration tests enforce this lock.
const PROTOCOL_HASH = '17c3b4fa1bc5bcc2b4179f83e35a9cbb53014c598643a5385221ebdf4f6797d8';
const SCHEMA = 'huqan-cog-m3-family-evaluation-v1';
const text = value => typeof value === 'string' && value.trim() === value && value.length > 0;
const hex = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const exact = (value, keys) => isPlainObject(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const hash = value => sha256Hex(stableStringify(value));
const check = (condition, reason) => { if (!condition) throw new TypeError(`invalid M3 experiment: ${reason}`); };
const base = { assertsGain: false, registered: false, authority: 'CANDIDATE_ONLY', intelligenceGain: 'NOT_MEASURED', cost: 'NOT_MEASURED' };
const sameFile = (a, b) => ['dev', 'ino', 'size', 'nlink', 'mtimeNs', 'ctimeNs'].every(key => a[key] === b[key]);

function fileHash(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const before = fs.fstatSync(fd, { bigint: true });
    check(before.isFile() && before.nlink === 1n && sameFile(before, fs.lstatSync(file, { bigint: true })), 'source_identity');
    const digest = createHash('sha256'), buffer = Buffer.alloc(65536);
    let remaining = before.size;
    while (remaining > 0n) {
      const count = fs.readSync(fd, buffer, 0, Number(remaining > 65536n ? 65536n : remaining), null);
      check(count > 0, 'source_changed'); digest.update(buffer.subarray(0, count)); remaining -= BigInt(count);
    }
    check(fs.readSync(fd, buffer, 0, 1, null) === 0 && sameFile(before, fs.fstatSync(fd, { bigint: true }))
      && sameFile(before, fs.lstatSync(file, { bigint: true })), 'source_changed');
    return digest.digest('hex');
  } finally { fs.closeSync(fd); }
}

function nativeResult(slot, candidates, workspaceId, oracle, lockFile, handles, asOf) {
  if (candidates.length === 0) {
    if (slot !== null) return { correct: 0, wrongWrite: 0, violations: ['unexpected_execution'] };
    return { correct: oracle.expected === 'refuse' ? 1 : 0, wrongWrite: 0, violations: [] };
  }
  if (!exact(slot, ['journal', 'journalHash', 'runId', 'sourceHash']) || !text(slot.runId) || !hex(slot.sourceHash)) return null;
  const file = lockFile(slot.journal, slot.journalHash);
  const store = openJournalConnection({ dbPath: file, readOnly: true });
  if (!store) return null;
  handles.push(store);
  const journal = createExperienceJournal({ store, readOnly: true });
  const source = readSealedRun(journal, slot.runId, workspaceId);
  if (!source.ok || source.sourceHash !== slot.sourceHash) return null;
  const begin = source.events.find(event => event.type === 'run_started'), header = begin?.payload?.predecision;
  const at = Date.parse(begin?.payload?.createdAt);
  if (!Number.isFinite(at) || at < Date.parse(asOf) || at > new Date().getTime()) return null;
  const suffix = /^(.*):c([1-8])$/.exec(slot.runId);
  if (!suffix) return null;
  const runs = Array.from({ length: Number(suffix[2]) }, (_, index) => `${suffix[1]}:c${index + 1}`);
  if (journal.runIds(workspaceId).some(id => id.startsWith(`${suffix[1]}:c`) && !runs.includes(id))) return null;
  let spec, ticket;
  if (header !== undefined) {
    if (!isPlainObject(header) || !isPlainObject(header.task)) return null;
    spec = header.task; ticket = header;
  } else {
    // CLI runs retain their sealed task/test declarations but have no AgentV3 prediction header.
    const proposals = runs.map(id => readSealedRun(journal, id, workspaceId).events?.find(event => event.type === 'action_proposed')?.payload);
    const test = source.events.find(event => event.type === 'run_closed')?.payload?.evidence?.test;
    if (!proposals.every(row => row?.operationType === 'replace_text') || typeof test?.command !== 'string') return null;
    spec = { id: begin.payload.taskId, allowedPaths: begin.payload.allowedPaths,
      candidates: proposals.map(row => ({ type: 'replace_text', path: row.path, findSha256: row.findSha256, replaceSha256: row.replaceSha256 })),
      testCommandHash: sha256Hex(test.command) };
    ticket = { baseRunId: suffix[1], scopeHash: hash(spec), sourceGroup: 'lab-native', decisionId: slot.runId };
  }
  const accepted = readOrdinaryAcceptance({ journal, workspaceId, spec, ticket, predecision: header });
  if (!accepted || accepted.runId !== slot.runId || accepted.sourceHash !== slot.sourceHash) return null;
  for (const id of runs) {
    const routes = readSealedRun(journal, id, workspaceId).events.filter(event => event.type === 'routing_decided');
    if (routes.length !== 1 || !candidates.some(candidate => candidate.procedure?.hash === routes[0].payload?.boundProcedureVersion
      && candidate.capabilityId === routes[0].payload?.chosenCapabilityId)) return null;
  }
  const finished = source.events.find(event => event.type === 'execution_finished');
  const verification = source.events.find(event => event.type === 'verification');
  const changes = finished?.payload?.changes, checks = verification?.payload?.checks;
  if (!Array.isArray(changes) || !Array.isArray(checks) || checks.length !== changes.length) return null;
  const confirmed = accepted.outcome === 'confirmed';
  if (confirmed && changes.some(change => !checks.some(observed => observed.path === change.path
    && observed.expectedSha256 === change.afterSha256 && hex(observed.actualSha256)
    && observed.match === (observed.expectedSha256 === observed.actualSha256)))) return null;
  const matches = oracle.files.length === changes.length && oracle.files.every(file => changes.some(change => change.path === file.path
    && (confirmed ? checks.find(observed => observed.path === change.path)?.actualSha256 : change.beforeSha256) === file.sha256));
  const correct = confirmed ? oracle.expected === 'change' && matches : oracle.expected === 'refuse' && (matches || oracle.files.length === 0);
  return { correct: correct ? 1 : 0, wrongWrite: confirmed && !correct ? 1 : 0, violations: [] };
}

function runM3FamilyExperiment(requestPath) {
  const request = readReplayRequest(requestPath), handles = [], locked = new Map();
  check(exact(request, ['schemaVersion', 'contract', 'workspaceId', 'asOf', 'splits', 'families', 'tasks', 'records',
    'oracleFile', 'oracleHash', 'protocolHash', 'lockHash']) && request.schemaVersion === SCHEMA && text(request.workspaceId)
    && typeof request.asOf === 'string' && Number.isFinite(Date.parse(request.asOf)) && Date.parse(request.asOf) <= new Date().getTime(), 'request');
  const { lockHash, ...body } = request;
  check(hex(lockHash) && hash(body) === lockHash, 'manifest_lock');
  const directory = path.dirname(path.resolve(requestPath));
  const lockFile = (file, expected) => {
    check(text(file) && hex(expected), 'source_lock');
    const absolute = path.resolve(directory, file);
    check((!locked.has(absolute) || locked.get(absolute) === expected) && fileHash(absolute) === expected, 'source_changed');
    locked.set(absolute, expected); return absolute;
  };
  try {
    check(request.protocolHash === PROTOCOL_HASH, 'protocol_lock');
    const oracle = readReplayRequest(lockFile(request.oracleFile, request.oracleHash));
    check(exact(oracle, ['schemaVersion', 'rows']) && oracle.schemaVersion === SCHEMA && Array.isArray(oracle.rows), 'oracle');
    const oracles = new Map();
    for (const row of oracle.rows) {
      check(exact(row, ['id', 'expected', 'files']) && text(row.id) && !oracles.has(row.id)
        && ['change', 'refuse'].includes(row.expected) && Array.isArray(row.files)
        && (row.expected === 'refuse' || row.files.length > 0)
        && row.files.every(file => exact(file, ['path', 'sha256']) && text(file.path) && hex(file.sha256))
        && new Set(row.files.map(file => file.path)).size === row.files.length, 'oracle_row');
      oracles.set(row.id, row);
    }
    check(exact(request.splits, ['source', 'qualification', 'evaluation']), 'splits');
    const seen = new Set();
    for (const split of Object.values(request.splits)) {
      check(Array.isArray(split) && split.every(text), 'split_labels');
      for (const family of split) { check(!seen.has(family), 'split_overlap'); seen.add(family); }
    }
    check(Array.isArray(request.families) && Array.isArray(request.tasks) && Array.isArray(request.records), 'corpus');
    const families = new Map(), comparisons = [], sourceDigests = new Set();
    for (const family of request.families) {
      check(exact(family, ['familyId', 'journal', 'predictionJournal', 'request', 'journalHash', 'predictionHash', 'requestHash'])
        && text(family.familyId) && !families.has(family.familyId) && request.splits.evaluation.includes(family.familyId), 'family');
      const journal = lockFile(family.journal, family.journalHash), prediction = lockFile(family.predictionJournal, family.predictionHash);
      const replayRequest = lockFile(family.request, family.requestHash), qualification = readReplayRequest(replayRequest);
      for (const input of qualification.qualificationInputs || []) {
        if (typeof input.before === 'string') sourceDigests.add(sha256Hex(input.before));
        if (typeof input.expectedAfter === 'string') sourceDigests.add(sha256Hex(input.expectedAfter));
      }
      const replay = runReplayComparison(['--from-replay', '--dry-run', '--journal', journal, '--prediction-journal', prediction,
        '--workspace', request.workspaceId, '--request', replayRequest, '--budget', '32'], { asOf: request.asOf });
      for (const arm of Object.values(replay)) for (const candidate of arm.candidates)
        for (const ref of candidate.sourceRefs || []) if (ref.startsWith('artifact:')) sourceDigests.add(ref.slice(9));
      families.set(family.familyId, replay);
      comparisons.push({ familyId: family.familyId, budget: 32, cutoff: request.asOf,
        sourceSnapshotHash: hash([family.journalHash, family.predictionHash, family.requestHash]),
        dependencyHash: hash([family.journalHash, request.workspaceId, request.asOf]),
        A1: replay.recent.selected.map(row => row.episodeId), A2: replay.priority.selected.map(row => row.episodeId) });
    }
    check(families.size === request.splits.evaluation.length, 'family_inventory');
    const observations = new Map();
    for (const row of request.records) {
      check(exact(row, ['taskId', 'A1', 'A2']) && text(row.taskId) && !observations.has(row.taskId), 'record');
      observations.set(row.taskId, row);
    }
    const tasks = new Set(), records = [];
    let missing = false;
    for (const task of request.tasks) {
      check(exact(task, ['taskId', 'familyId', 'split', 'oracleId']) && text(task.taskId) && !tasks.has(task.taskId)
        && families.has(task.familyId) && ['holdout', 'transfer'].includes(task.split) && oracles.has(task.oracleId), 'task');
      tasks.add(task.taskId);
      const expected = oracles.get(task.oracleId), observed = observations.get(task.taskId);
      check(!expected.files.some(file => sourceDigests.has(file.sha256)), 'qualification_or_source_overlap');
      if (!observed) { missing = true; continue; }
      const replay = families.get(task.familyId);
      const A1 = nativeResult(observed.A1, replay.recent.candidates.filter(row => row.procedure), request.workspaceId, expected, lockFile, handles, request.asOf);
      const A2 = nativeResult(observed.A2, replay.priority.candidates.filter(row => row.procedure), request.workspaceId, expected, lockFile, handles, request.asOf);
      if ([A1, A2].some(row => row?.wrongWrite === 1 || row?.violations.length)) return { ...base, status: 'REJECT', reason: 'trust_violation' };
      if (!A1 || !A2) missing = true;
      else records.push({ taskId: task.taskId, familyId: task.familyId, split: task.split, A1, A2 });
    }
    check([...observations.keys()].every(id => tasks.has(id)), 'orphan_record');
    for (const [file, expected] of locked) check(fileHash(file) === expected, 'source_changed');
    const report = evaluateM3Families({ contract: request.contract, records, comparisons });
    if (report.status !== 'REJECT' && missing) return { ...base, status: 'INSUFFICIENT', reason: 'native_evidence_unavailable' };
    return { ...report, ...base, evidence: 'READ_ONLY_VALIDATED', familyLabels: 'CALLER_DECLARED', experiment: 'NOT_RUN', comparisons };
  } finally { handles.forEach(handle => handle.close()); }
}

module.exports = { runM3FamilyExperiment };
