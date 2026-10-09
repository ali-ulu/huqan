'use strict';

const { createHash } = require('node:crypto');
const { types } = require('node:util');
const { projectFiles } = require('./project-templates');

const MAX_ROUTES = 8;
const MAX_SPEC_BYTES = 16384;

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function jsonValue(value, depth = 0) {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.length <= 64 && value.every(item => jsonValue(item, depth + 1));
  return plain(value) && Object.keys(value).length <= 64
    && Object.values(value).every(item => jsonValue(item, depth + 1));
}

function refuse(reason) {
  return { ok: false, outcome: 'needs_human_decision', reason, task: null, plan: null };
}

function onlyKeys(value, keys) {
  return Reflect.ownKeys(value).every(key => typeof key === 'string' && keys.includes(key)
    && Object.getOwnPropertyDescriptor(value, key).enumerable
    && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'));
}

// This producer selects a closed, versioned recipe. It never infers missing
// requirements, executes code or carries mutation approval.
function produceProject(spec) {
  if (!safeData(spec)) return refuse('PROJECT_SPEC_INVALID');
  if (!plain(spec) || !onlyKeys(spec, ['kind', 'name', 'archetype', 'routes'])) return refuse('PROJECT_SPEC_INVALID');
  if (spec.kind !== 'project_spec' || spec.archetype !== 'node_json_api') return refuse('PROJECT_ARCHETYPE_UNSUPPORTED');
  if (typeof spec.name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(spec.name)) return refuse('PROJECT_NAME_INVALID');
  if (!Array.isArray(spec.routes) || spec.routes.length === 0 || spec.routes.length > MAX_ROUTES) return refuse('PROJECT_ROUTES_INVALID');
  const paths = new Set();
  for (const route of spec.routes) {
    if (!plain(route) || !onlyKeys(route, ['path', 'body']) || typeof route.path !== 'string'
      || route.path.length > 128 || !/^\/(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)?$/u.test(route.path)
      || paths.has(route.path) || !plain(route.body) || !jsonValue(route.body)) return refuse('PROJECT_ROUTE_INVALID');
    paths.add(route.path);
  }
  const serialized = JSON.stringify(spec);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SPEC_BYTES) return refuse('PROJECT_SPEC_OVER_CAP');
  // Detach caller-owned data so changing the request cannot change the plan.
  const normalized = JSON.parse(serialized);
  const specHash = createHash('sha256').update(serialized).digest('hex');
  const files = projectFiles(normalized);
  const acceptanceCommand = 'node --test test/api.test.js';
  const plan = { archetype: 'node_json_api', recipeVersion: '1', specHash,
    phases: ['requirements', 'design', 'generate', 'test', 'independent_verify'],
    files: Object.keys(files), acceptanceCommand,
    requirements: normalized.routes.map(route => ({ method: 'GET', path: route.path, test: 'test/api.test.js' })) };
  const task = { id: `project-${specHash.slice(0, 16)}`, level: 'l0',
    intent: `implement declared node_json_api project ${normalized.name}`,
    allowedPaths: Object.keys(files), files: {},
    operation: { type: 'sequence', steps: Object.entries(files).map(([path, content]) => ({ type: 'create_file', path, content })) },
    test: { command: acceptanceCommand },
  };
  return { ok: true, outcome: 'proposed', reason: null, plan, task };
}

// Reject executable properties before reading values or serializing input.
function safeData(value, seen = new Set(), depth = 0) {
  if (depth > 10) return false;
  if (value === null || typeof value !== 'object') return typeof value !== 'function';
  if (types.isProxy(value)) return false;
  if (seen.has(value) || (Array.isArray(value)
    ? Object.getPrototypeOf(value) !== Array.prototype : !plain(value))) return false;
  seen.add(value);
  const ok = Reflect.ownKeys(value).every(key => {
    if (Array.isArray(value) && key === 'length') return true;
    if (Array.isArray(value) && !/^(0|[1-9][0-9]*)$/u.test(String(key))) return false;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return typeof key === 'string' && key !== 'toJSON' && descriptor.enumerable
      && Object.hasOwn(descriptor, 'value') && safeData(descriptor.value, seen, depth + 1);
  });
  seen.delete(value);
  return ok;
}

module.exports = { produceProject };
