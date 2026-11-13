'use strict';

const { createHash } = require('node:crypto');
const { types } = require('node:util');
const { readStringArrayTarget } = require('./string-array-target');
const { renderStringArrayProgram } = require('./string-array-program');
const { readSealedRun } = require('./learning-intake');

const digest = text => createHash('sha256').update(text, 'utf8').digest('hex');
const hashPattern = /^[a-f0-9]{64}$/u;
const validPath = path => typeof path === 'string' && path.length > 0 && path.length <= 1024
  && !path.includes('\\') && !path.includes('\0') && !path.startsWith('/')
  && !path.split('/').some(part => !part || part === '.' || part === '..' || part.includes(':'));
function ownValue(value, key) {
  if (!value || typeof value !== 'object' || types.isProxy(value)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && Object.hasOwn(descriptor, 'value') ? descriptor.value : undefined;
}
function record(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length || !keys.every(key => descriptors[key]
    && descriptors[key].enumerable && Object.hasOwn(descriptors[key], 'value'))) return null;
  return Object.fromEntries(keys.map(key => [key, descriptors[key].value]));
}
function operationOf(task, operation) {
  const direct = record(operation, ['type', 'path', 'find', 'replace']);
  if (direct) return direct;
  const intent = record(operation, ['type', 'path']);
  const experience = ownValue(task, 'experience');
  const candidates = ownValue(experience, 'candidates');
  const intentOnly = ownValue(experience, 'intentOnly');
  if (!intent || intentOnly !== true || !candidates || types.isProxy(candidates)
    || !Array.isArray(candidates) || candidates.length !== 1
    || Reflect.ownKeys(candidates).length !== 2) return null;
  const candidate = ownValue(candidates, '0');
  const params = record(ownValue(candidate, 'params'), ['path', 'oldText', 'newText']);
  return params && params.path === intent.path
    ? { type: intent.type, path: intent.path, find: params.oldText, replace: params.newText } : null;
}
function deriveStringArrayEvidence({ task, operation, content, runId, workspaceId, eventId } = {}) {
  try {
    const target = record(ownValue(task, 'synthesisEvidenceTarget'), ['binding', 'separator']);
    const declaredPin = record(ownValue(task, 'synthesisSourcePin'), ['path', 'sha256']);
    const op = operationOf(task, operation);
    if (!target || !declaredPin || !validPath(declaredPin.path) || typeof declaredPin.sha256 !== 'string'
      || !hashPattern.test(declaredPin.sha256)
      || !op || op.type !== 'replace_text' || op.path !== declaredPin.path
      || typeof op.find !== 'string' || typeof op.replace !== 'string' || typeof content !== 'string'
      || digest(content) !== declaredPin.sha256
      || ![runId, workspaceId, eventId].every(value => typeof value === 'string' && value.length > 0)) return null;
    const before = readStringArrayTarget(content, target);
    if (!before || before.find !== op.find || content.split(op.find).length !== 2) return null;
    const afterSource = content.slice(0, before.expressionStart) + op.replace + content.slice(before.expressionEnd);
    const after = readStringArrayTarget(afterSource, target);
    if (!after || after.find !== op.replace || before.target.separator !== after.target.separator
      || before.instantiate(after.program) !== op.replace) return null;
    const method = { schemaVersion: 1, family: 'string-array-join',
      before: { type: before.program.type, separator: before.program.separator },
      after: { type: after.program.type, separator: after.program.separator } };
    return { schemaVersion: 1, family: 'string-array-join', methodHash: digest(JSON.stringify(method)),
      context: { runId, workspaceId, eventId }, sourcePin: declaredPin,
      selector: target, before: method.before, after: method.after,
      afterSourceSha256: digest(afterSource), findSha256: digest(op.find), replaceSha256: digest(op.replace) };
  } catch { return null; }
}
function prepareStringArrayEvidence({ task, operation, readSource, runId, workspaceId, eventId } = {}) {
  const required = Boolean(task && typeof task === 'object' && (types.isProxy(task)
    || Object.hasOwn(task, 'synthesisEvidenceTarget')));
  if (!required) return { required: false, evidence: null };
  try {
    const pin = record(ownValue(task, 'synthesisSourcePin'), ['path', 'sha256']);
    const target = record(ownValue(task, 'synthesisEvidenceTarget'), ['binding', 'separator']);
    const op = operationOf(task, operation);
    if (!pin || !target || !op || !validPath(pin.path) || typeof pin.sha256 !== 'string'
      || !hashPattern.test(pin.sha256)
      || op.path !== pin.path || typeof op.find !== 'string' || typeof op.replace !== 'string')
      return { required: true, evidence: null };
    const content = typeof readSource === 'function' ? readSource(pin.path) : null;
    if (typeof content === 'string' && digest(content) !== pin.sha256)
      return { required: true, evidence: null, reason: 'SYNTHESIS_SOURCE_CHANGED' };
    return { required: true, evidence: deriveStringArrayEvidence({ task, operation, content, runId, workspaceId, eventId }) };
  } catch { return { required: true, evidence: null }; }
}
function matchesSemanticOperation(evidence, actualOperation) {
  try {
    const op = record(actualOperation, ['type', 'path', 'find', 'replace']);
    const fields = record(evidence, ['schemaVersion', 'family', 'methodHash', 'context', 'sourcePin',
      'selector', 'before', 'after', 'afterSourceSha256', 'findSha256', 'replaceSha256']);
    const pin = record(fields?.sourcePin, ['path', 'sha256']);
    return Boolean(op && fields && pin && op.type === 'replace_text' && op.path === pin.path
      && typeof op.find === 'string' && typeof op.replace === 'string'
      && digest(op.find) === fields.findSha256 && digest(op.replace) === fields.replaceSha256);
  } catch { return false; }
}
function readSealedStringArrayEvidence(journal, runId, workspaceId) {
  try {
    const sealed = readSealedRun(journal, runId, workspaceId);
    if (!sealed.ok || sealed.manifest?.closed !== true) return null;
    const events = sealed.events;
    const kinds = ['run_started', 'action_proposed', 'policy_decided', 'execution_started',
      'execution_finished', 'verification', 'run_closed'];
    if (!Array.isArray(events) || events.length < kinds.length || events.length > kinds.length + 1
      || events[0]?.type !== kinds[0] || events.at(-1)?.type !== kinds.at(-1)) return null;
    const routeIndex = events.findIndex(row => row.type === 'routing_decided');
    const expected = routeIndex < 0 ? kinds : [...kinds.slice(0, 3), 'routing_decided', ...kinds.slice(3)];
    if (events.length !== expected.length || !events.every((row, at) => row?.type === expected[at]
      && row.runId === runId && row.workspaceId === workspaceId
      && (at === 0 || row.causedByEventId === events[at - 1].eventId))) return null;
    const proposed = events[1].payload;
    const evidence = record(ownValue(proposed, 'semanticEvidence'), ['schemaVersion', 'family', 'methodHash',
      'context', 'sourcePin', 'selector', 'before', 'after', 'afterSourceSha256', 'findSha256', 'replaceSha256']);
    const context = record(evidence?.context, ['runId', 'workspaceId', 'eventId']);
    const pin = record(evidence?.sourcePin, ['path', 'sha256']);
    const selector = record(evidence?.selector, ['binding', 'separator']);
    const before = record(evidence?.before, ['type', 'separator']);
    const after = record(evidence?.after, ['type', 'separator']);
    if (!context || !pin || !selector || !before || !after || evidence.schemaVersion !== 1
      || evidence.family !== 'string-array-join' || context.runId !== runId
      || context.workspaceId !== workspaceId || context.eventId !== events[1].eventId
      || !validPath(pin.path)
      || ![evidence.methodHash, pin.sha256, evidence.afterSourceSha256, evidence.findSha256,
        evidence.replaceSha256].every(value => typeof value === 'string' && hashPattern.test(value))
      || evidence.methodHash !== digest(JSON.stringify({ schemaVersion: 1, family: evidence.family, before, after }))
      || selector.separator !== before.separator || selector.separator !== after.separator
      || proposed.operationType !== 'replace_text' || proposed.path !== pin.path
      || proposed.findSha256 !== evidence.findSha256 || proposed.replaceSha256 !== evidence.replaceSha256) return null;
    const expression = program => renderStringArrayProgram(program, selector.binding).slice(7, -1);
    expression(before);
    if (digest(expression(after)) !== evidence.replaceSha256) return null;
    const uniqueBeforeHash = digest(expression({ type: 'stableUniqueJoin', separator: selector.separator }));
    if ((before.type === 'stableUniqueJoin') !== (evidence.findSha256 === uniqueBeforeHash)) return null;
    if (!readStringArrayTarget(`${selector.binding}.join(${JSON.stringify(selector.separator)})`, selector)) return null;
    const routed = routeIndex < 0 ? null : events[routeIndex].payload?.execution;
    if (routeIndex >= 0 && !routed) return null;
    if (routed && (routed.operationType !== 'replace_text' || routed.path !== pin.path
      || routed.findSha256 !== evidence.findSha256 || routed.replaceSha256 !== evidence.replaceSha256)) return null;
    const decision = events[2].payload;
    const executed = events[expected.indexOf('execution_finished')];
    const verified = events[expected.indexOf('verification')];
    const closed = events.at(-1);
    const changes = executed.payload?.changes;
    const checks = verified.payload?.checks;
    const change = Array.isArray(changes) && changes.length === 1 ? changes[0] : null;
    const check = Array.isArray(checks) && checks.length === 1 ? checks[0] : null;
    const proofs = verified.proofs;
    const test = closed.payload?.evidence?.test;
    if (decision?.decision !== 'allow' || executed.executionStatus !== 'completed'
      || change?.path !== pin.path || change.afterSha256 !== evidence.afterSourceSha256
      || check?.path !== pin.path || check.expectedSha256 !== evidence.afterSourceSha256
      || check.actualSha256 !== evidence.afterSourceSha256 || check.match !== true
      || verified.payload.verified !== true || verified.outcomeStatus !== 'verified'
      || !proofs || !['integrity', 'coverage', 'verification', 'provenance', 'permission'].every(key => proofs[key] === true)
      || closed.executionStatus !== 'completed' || closed.outcomeStatus !== 'verified'
      || closed.payload?.verdict !== 'complete' || closed.payload.evidence?.kept !== true
      || closed.payload.evidence.rolledBack !== false || test?.ran !== true || test.ok !== true
      || test.exitCode !== 0) return null;
    return evidence;
  } catch { return null; }
}
module.exports = { deriveStringArrayEvidence, prepareStringArrayEvidence,
  matchesSemanticOperation, readSealedStringArrayEvidence };
