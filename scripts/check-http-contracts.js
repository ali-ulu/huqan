#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const { PUBLIC_ROUTES, AUTHENTICATED_ROUTES } = require('../lib/http/route-auth-policy');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_CONFIG_PATH = path.join(ROOT, 'config', 'http-contracts.json');
const GATED_SOURCE_PATH = path.join(ROOT, 'lib', 'http', 'deployment-gated-route-auth.js');
const BODY_METHODS = new Set(['POST', 'PUT', 'PATCH']);
const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const REQUEST_MODES = new Set(['no-body', 'schema', 'bounded-parser', 'signed-body', 'bounded-exception']);
const SPECIAL_REST_PATHS = new Set([
  '/health',
  '/graph-data',
  '/v2-status',
  '/llm-sor',
  '/answer',
  '/dogrula',
  '/verify',
  '/yukle',
  '/upload',
]);

function loadConfig(file = DEFAULT_CONFIG_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function rulePath(rule) {
  if (typeof rule?.match?.pathname === 'string') return rule.match.pathname;
  if (typeof rule?.match?.prefix === 'string') return rule.match.prefix;
  return '';
}

function isRestLikePath(value) {
  const pathname = String(value || '');
  return SPECIAL_REST_PATHS.has(pathname)
    || pathname === '/api'
    || pathname.startsWith('/api/')
    || pathname.startsWith('/v1/')
    || pathname.startsWith('/v2/');
}

function deploymentGatedRouteIds(source) {
  const ids = [];
  for (const match of String(source || '').matchAll(/ruleId:\s*'([^']+)'/g)) {
    if (match[1] === 'unknown' || ids.includes(match[1])) continue;
    ids.push(match[1]);
  }
  return ids.sort();
}

function collectDeclaredRestRoutes(options = {}) {
  const gatedSource = options.gatedSource === undefined
    ? fs.readFileSync(GATED_SOURCE_PATH, 'utf8')
    : options.gatedSource;
  const routes = [];

  for (const rule of PUBLIC_ROUTES) {
    const pathname = rulePath(rule);
    if (!isRestLikePath(pathname)) continue;
    routes.push({
      routeId: rule.id,
      exposure: 'public',
      path: pathname,
      policyMethods: Array.isArray(rule.methods) ? [...rule.methods].sort() : null,
    });
  }

  for (const rule of AUTHENTICATED_ROUTES) {
    const pathname = rulePath(rule);
    if (!isRestLikePath(pathname)) continue;
    routes.push({
      routeId: rule.id,
      exposure: 'authenticated',
      path: pathname,
      policyMethods: Array.isArray(rule.methods) ? [...rule.methods].sort() : null,
    });
  }

  for (const routeId of deploymentGatedRouteIds(gatedSource)) {
    routes.push({
      routeId,
      exposure: 'deployment-gated',
      path: null,
      policyMethods: null,
    });
  }

  return routes.sort((a, b) => a.routeId.localeCompare(b.routeId));
}

function ownerPath(value) {
  const relative = String(value || '');
  const resolved = path.resolve(ROOT, relative);
  if (!relative || (resolved !== ROOT && !resolved.startsWith(`${ROOT}${path.sep}`))) return null;
  return resolved;
}

function sourceContains(owner, evidence, readFile = fs.readFileSync) {
  const target = ownerPath(owner);
  if (!target || !fs.existsSync(target)) return { exists: false, missing: [...evidence] };
  const source = readFile(target, 'utf8');
  return {
    exists: true,
    missing: evidence.filter((token) => !source.includes(token)),
  };
}

function flattenContracts(config) {
  const result = [];
  for (const family of Array.isArray(config?.contracts) ? config.contracts : []) {
    for (const routeId of Array.isArray(family.routeIds) ? family.routeIds : []) {
      result.push({
        routeId,
        family: family.family,
        exposure: family.exposure,
        path: family.path || null,
        methods: Array.isArray(family.methods) ? [...family.methods].sort() : [],
        request: family.request || {},
        response: family.response || {},
      });
    }
  }
  return result;
}

function validateHttpContracts(config, options = {}) {
  const readFile = options.readFile || fs.readFileSync;
  const declarations = options.declarations || collectDeclaredRestRoutes(options);
  const errors = [];
  const nonRest = new Set(config?.nonRestDeploymentRouteIds || []);
  const expected = declarations.filter((item) =>
    item.exposure !== 'deployment-gated' || !nonRest.has(item.routeId));
  const expectedById = new Map(expected.map((item) => [item.routeId, item]));
  const contracts = flattenContracts(config);
  const byId = new Map();

  if (config?.schemaVersion !== 1) errors.push('config schemaVersion must be 1');

  for (const item of contracts) {
    if (!item.routeId) {
      errors.push(`contract family ${item.family || '<unnamed>'} contains an empty route id`);
      continue;
    }
    if (byId.has(item.routeId)) {
      errors.push(`route ${item.routeId} is classified more than once`);
      continue;
    }
    byId.set(item.routeId, item);

    const declaration = expectedById.get(item.routeId);
    if (!declaration) {
      errors.push(`contract inventory contains undeclared REST route ${item.routeId}`);
      continue;
    }
    if (item.exposure !== declaration.exposure) {
      errors.push(`route ${item.routeId} exposure is ${item.exposure}, expected ${declaration.exposure}`);
    }
    if (declaration.exposure === 'deployment-gated' && !item.path) {
      errors.push(`deployment-gated route ${item.routeId} must record its path/pattern`);
    }
    if (declaration.policyMethods) {
      const actual = [...item.methods].sort();
      if (JSON.stringify(actual) !== JSON.stringify(declaration.policyMethods)) {
        errors.push(`public route ${item.routeId} methods ${actual.join(',')} do not match policy methods ${declaration.policyMethods.join(',')}`);
      }
    }

    if (item.methods.length === 0) errors.push(`route ${item.routeId} must record at least one method`);
    for (const method of item.methods) {
      if (!HTTP_METHODS.has(method)) errors.push(`route ${item.routeId} has invalid method ${method}`);
    }

    const requestMode = item.request?.mode;
    if (!REQUEST_MODES.has(requestMode)) {
      errors.push(`route ${item.routeId} has invalid request mode ${requestMode || '<missing>'}`);
    }
    if (item.methods.some((method) => BODY_METHODS.has(method)) && requestMode === 'no-body') {
      errors.push(`body-bearing route ${item.routeId} cannot use request mode no-body`);
    }
    if (requestMode === 'bounded-exception' && String(item.request?.reason || '').trim().length < 24) {
      errors.push(`route ${item.routeId} bounded exception needs a concrete reason`);
    }

    const requestOwner = item.request?.owner;
    const requestEvidence = Array.isArray(item.request?.evidence) ? item.request.evidence : [];
    const requestCheck = sourceContains(requestOwner, requestEvidence, readFile);
    if (!requestCheck.exists) errors.push(`route ${item.routeId} request contract owner does not exist: ${requestOwner || '<missing>'}`);
    for (const token of requestCheck.missing) {
      errors.push(`route ${item.routeId} lost request-validation evidence in ${requestOwner}: ${token}`);
    }

    const responseOwner = item.response?.owner;
    const responseTarget = ownerPath(responseOwner);
    if (!responseTarget || !fs.existsSync(responseTarget)) {
      errors.push(`route ${item.routeId} response contract owner does not exist: ${responseOwner || '<missing>'}`);
    }

    if (item.routeId.startsWith('workflow-')
        && item.methods.some((method) => BODY_METHODS.has(method))) {
      if (requestMode !== 'schema' || !requestEvidence.includes('validateWorkflowHttpRequest')) {
        errors.push(`workflow route ${item.routeId} must reuse validateWorkflowHttpRequest as its request-schema authority`);
      }
    }
  }

  for (const declaration of expected) {
    if (!byId.has(declaration.routeId)) {
      errors.push(`declared REST route is missing contract inventory: ${declaration.routeId}`);
    }
  }

  for (const routeId of nonRest) {
    const declaration = declarations.find((item) => item.routeId === routeId);
    if (!declaration || declaration.exposure !== 'deployment-gated') {
      errors.push(`non-REST deployment exemption is stale or unknown: ${routeId}`);
    }
  }

  return errors.sort();
}

function buildInventoryReport(config, options = {}) {
  const declarations = options.declarations || collectDeclaredRestRoutes(options);
  const declarationsById = new Map(declarations.map((item) => [item.routeId, item]));
  const nonRest = new Set(config?.nonRestDeploymentRouteIds || []);

  return {
    schemaVersion: 1,
    generatedFrom: [
      'lib/http/route-auth-policy.js',
      'lib/http/deployment-gated-route-auth.js',
      'config/http-contracts.json',
    ],
    routes: flattenContracts(config)
      .filter((item) => !nonRest.has(item.routeId))
      .map((item) => {
        const declaration = declarationsById.get(item.routeId) || {};
        return {
          routeId: item.routeId,
          family: item.family,
          exposure: item.exposure,
          path: declaration.path || item.path,
          methods: item.methods,
          request: {
            mode: item.request.mode,
            owner: item.request.owner,
            evidence: item.request.evidence || [],
            ...(item.request.reason ? { reason: item.request.reason } : {}),
          },
          response: { owner: item.response.owner },
        };
      })
      .sort((a, b) => a.routeId.localeCompare(b.routeId)),
  };
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--write') {
      result.write = argv[index + 1];
      index += 1;
    }
  }
  return result;
}

function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const config = loadConfig();
  const errors = validateHttpContracts(config);
  const report = buildInventoryReport(config);

  if (args.write) {
    const target = path.resolve(args.write);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`);
  }

  if (errors.length > 0) {
    console.error('HTTP contract inventory failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`HTTP contract inventory passed: ${report.routes.length} REST route declarations covered.`);
}

if (require.main === module) main();

module.exports = {
  buildInventoryReport,
  collectDeclaredRestRoutes,
  deploymentGatedRouteIds,
  flattenContracts,
  isRestLikePath,
  loadConfig,
  validateHttpContracts,
};
