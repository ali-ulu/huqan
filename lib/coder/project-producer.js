'use strict';

const { createHash } = require('node:crypto');
const { projectFiles } = require('./project-templates');
const { plain, jsonValue, onlyKeys, safeData } = require('./project-spec-data');
const { produceComputedProject } = require('./project-compute');

const MAX_ROUTES = 8;
const MAX_SPEC_BYTES = 16384;


function refuse(reason) {
  return { ok: false, outcome: 'needs_human_decision', reason, task: null, plan: null };
}


// This producer selects a closed, versioned recipe. It never infers missing
// requirements, executes code or carries mutation approval.
function produceProject(spec, options = {}) {
  if (!safeData(spec)) return refuse('PROJECT_SPEC_INVALID');
  if (!plain(spec) || !onlyKeys(spec, ['kind', 'name', 'archetype', 'routes'])) return refuse('PROJECT_SPEC_INVALID');
  if (spec.kind !== 'project_spec' || !['node_json_api', 'node_computed_json_api'].includes(spec.archetype))
    return refuse('PROJECT_ARCHETYPE_UNSUPPORTED');
  if (typeof spec.name !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/u.test(spec.name)) return refuse('PROJECT_NAME_INVALID');
  if (!Array.isArray(spec.routes) || spec.routes.length === 0 || spec.routes.length > MAX_ROUTES) return refuse('PROJECT_ROUTES_INVALID');
  const paths = new Set();
  for (const route of spec.routes) {
    if (!plain(route) || !onlyKeys(route, spec.archetype === 'node_json_api' ? ['path', 'body'] : ['path', 'compute', 'inputField', 'compose', 'composeScalar', 'pipeline', 'acceptanceExamples']) || typeof route.path !== 'string'
      || route.path.length > 128 || !/^\/(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*)?$/u.test(route.path)
      || paths.has(route.path) || (spec.archetype === 'node_json_api' && (!plain(route.body) || !jsonValue(route.body))))
      return refuse('PROJECT_ROUTE_INVALID');
    paths.add(route.path);
  }
  const serialized = JSON.stringify(spec);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_SPEC_BYTES) return refuse('PROJECT_SPEC_OVER_CAP');
  // Detach caller-owned data so changing the request cannot change the plan.
  const normalized = JSON.parse(serialized);
  const specHash = createHash('sha256').update(serialized).digest('hex');
  const computed = spec.archetype === 'node_computed_json_api' ? produceComputedProject(spec, options) : null;
  if (computed && !computed.ok) return refuse(computed.reason);
  const files = computed ? computed.files : projectFiles(normalized);
  const acceptanceCommand = 'node --test test/api.test.js';
  const plan = { archetype: spec.archetype, recipeVersion: '1', specHash,
    phases: ['requirements', 'design', 'generate', 'test', 'independent_verify'],
    files: Object.keys(files), acceptanceCommand,
    requirements: computed ? computed.requirements
      : normalized.routes.map(route => ({ method: 'GET', path: route.path, test: 'test/api.test.js' })),
    ...(computed ? { computation: computed.computation } : {}) };
  const task = { id: `project-${specHash.slice(0, 16)}`, level: 'l0',
    intent: `implement declared ${spec.archetype} project ${normalized.name}`,
    allowedPaths: Object.keys(files), files: {},
    operation: { type: 'sequence', steps: Object.entries(files).map(([path, content]) => ({ type: 'create_file', path, content })) },
    test: { command: acceptanceCommand },
  };
  return { ok: true, outcome: 'proposed', reason: null, plan, task };
}


module.exports = { produceProject };
