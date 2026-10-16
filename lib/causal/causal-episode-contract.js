'use strict';

const { contentHash } = require('../content-hash');
const { isPlainObject } = require('../is-plain-object');

const VERSION = 'huqan-causal-episode-v1';
const MAX_KEYS = 8;
function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}
function digest(value) { return contentHash(stable(value)); }
function text(value, field) {
  if (typeof value !== 'string' || !value.trim() || value.length > 128 || value.includes('\0')) throw new TypeError(`${field} must be bounded text`);
  return value;
}
function fields(value, allowed, field) {
  if (!isPlainObject(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new TypeError(`${field} has invalid fields`);
}
function state(value, field = 'state') {
  if (!isPlainObject(value) || Object.keys(value).length === 0 || Object.keys(value).length > MAX_KEYS) throw new TypeError(`${field} must have 1-${MAX_KEYS} scalar keys`);
  const copy = {};
  for (const key of Object.keys(value).sort()) {
    if (!/^[a-zA-Z][a-zA-Z0-9_]{0,63}$/.test(key) || ['constructor', 'prototype'].includes(key)) throw new TypeError(`${field} has invalid key`);
    const item = value[key];
    if (!(item === null || typeof item === 'boolean' || (typeof item === 'number' && Number.isFinite(item)) || (typeof item === 'string' && item.length <= 128))) throw new TypeError(`${field}.${key} must be a bounded scalar`);
    copy[key] = item;
  }
  return Object.freeze(copy);
}
function action(value) {
  fields(value, ['name', 'args', 'cost'], 'action');
  const name = text(value.name, 'action.name');
  const args = value.args === undefined || (isPlainObject(value.args) && Object.keys(value.args).length === 0)
    ? Object.freeze({}) : state(value.args, 'action.args');
  if (typeof value.cost !== 'number' || !Number.isFinite(value.cost) || value.cost < 0 || value.cost > 1e6) throw new TypeError('action.cost must be bounded non-negative number');
  return Object.freeze({ name, args, cost: value.cost });
}
function actionKey(value) { return digest({ name: value.name, args: value.args }); }
function delta(before, after) {
  const changes = {};
  for (const key of Object.keys(after)) if (before[key] !== after[key]) changes[key] = after[key];
  return Object.freeze(changes);
}
/** Episodes are verified journal outcomes, not proposed plans or time-ordered logs. */
function episodeFromEvent(event, scope) {
  if (stable(event)?.length > 65536) throw new TypeError('source event exceeds bounded length');
  if (!isPlainObject(event) || event.type !== 'verification' || event.outcomeStatus !== 'verified' || event.executionStatus !== 'completed') throw new TypeError('completed verified journal outcome required');
  if (event.workspaceId !== scope.workspaceId) throw new TypeError('workspace mismatch');
  if (!Number.isInteger(event.sequence) || event.sequence < 1) throw new TypeError('journal-assigned sequence required');
  const input = event.payload && event.payload.causalEpisode;
  fields(input, ['frameId', 'preState', 'action', 'postState', 'effect', 'observedAt', 'assignment'], 'causalEpisode');
  if (input.frameId !== scope.frameId) throw new TypeError('frame mismatch');
  const preState = state(input.preState, 'preState');
  const postState = state(input.postState, 'postState');
  if (stable(Object.keys(preState)) !== stable(Object.keys(postState))) throw new TypeError('state schema changed');
  const effect = delta(preState, postState);
  if (stable(input.effect) !== stable(effect)) throw new TypeError('effect does not match observed transition');
  if (typeof input.observedAt !== 'string' || !Number.isFinite(Date.parse(input.observedAt))) throw new TypeError('observedAt must be an instant');
  const at = new Date(input.observedAt).toISOString();
  fields(input.assignment, ['kind', 'pairId', 'arm', 'independenceKey'], 'assignment');
  if (!['controlled', 'observational'].includes(input.assignment.kind)) throw new TypeError('unknown assignment kind');
  if (!['treatment', 'control'].includes(input.assignment.arm)) throw new TypeError('unknown assignment arm');
  const assignment = Object.freeze({
    kind: input.assignment.kind,
    pairId: text(input.assignment.pairId, 'assignment.pairId'),
    arm: input.assignment.arm,
    independenceKey: text(input.assignment.independenceKey, 'assignment.independenceKey'),
  });
  return Object.freeze({ schemaVersion: VERSION, workspaceId: text(scope.workspaceId, 'workspaceId'), frameId: text(scope.frameId, 'frameId'),
    runId: text(event.runId, 'runId'), eventId: text(event.eventId, 'eventId'), attemptId: text(event.attemptId, 'attemptId'),
    sourceHash: digest(event), preState, action: action(input.action), postState, effect, observedAt: at, assignment });
}
module.exports = { VERSION, MAX_KEYS, stable, digest, text, state, action, actionKey, delta, episodeFromEvent };
