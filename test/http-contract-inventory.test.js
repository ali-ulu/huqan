'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  buildInventoryReport,
  collectDeclaredRestRoutes,
  loadConfig,
  validateHttpContracts,
} = require('../scripts/check-http-contracts');

test('current REST surface has one complete contract classification per declared route', () => {
  const config = loadConfig();
  const errors = validateHttpContracts(config);
  assert.deepEqual(errors, []);

  const report = buildInventoryReport(config);
  assert.ok(report.routes.length >= 50, `expected a broad REST inventory, got ${report.routes.length}`);
  for (const route of report.routes) {
    assert.ok(route.path, `${route.routeId} is missing path/pattern`);
    assert.ok(route.methods.length > 0, `${route.routeId} is missing methods`);
    assert.ok(route.request.owner, `${route.routeId} is missing request owner`);
    assert.ok(route.response.owner, `${route.routeId} is missing response owner`);
  }
});

test('a newly declared REST route fails until the inventory classifies it', () => {
  const config = loadConfig();
  const declarations = collectDeclaredRestRoutes();
  declarations.push({
    routeId: 'synthetic-unguarded-route',
    exposure: 'authenticated',
    path: '/api/synthetic-unguarded',
    policyMethods: null,
  });

  const errors = validateHttpContracts(config, { declarations });
  assert.ok(
    errors.some((error) => error.includes('declared REST route is missing contract inventory: synthetic-unguarded-route')),
    errors.join('\n'),
  );
});

test('body-bearing routes cannot be downgraded to a no-body contract', () => {
  const config = structuredClone(loadConfig());
  const family = config.contracts.find((item) => item.routeIds.includes('v2-verify'));
  family.request.mode = 'no-body';

  const errors = validateHttpContracts(config);
  assert.ok(
    errors.some((error) => error.includes('body-bearing route v2-verify cannot use request mode no-body')),
    errors.join('\n'),
  );
});

test('removing executable request-validation evidence fails the gate', () => {
  const config = loadConfig();
  const target = path.join('lib', 'http', 'read-workflow-actions.js');

  const errors = validateHttpContracts(config, {
    readFile(file, encoding) {
      const source = fs.readFileSync(file, encoding);
      if (file.endsWith(target)) return source.replaceAll('validateWorkflowHttpRequest', 'validation_removed');
      return source;
    },
  });

  assert.ok(
    errors.some((error) =>
      error.includes('workflow-ask lost request-validation evidence')
        && error.includes('validateWorkflowHttpRequest')),
    errors.join('\n'),
  );
});

test('a new deployment-gated API rule is discovered and requires classification', () => {
  const config = loadConfig();
  const base = fs.readFileSync(
    path.join(__dirname, '..', 'lib', 'http', 'deployment-gated-route-auth.js'),
    'utf8',
  );
  const declarations = collectDeclaredRestRoutes({
    gatedSource: `${base}\n// mutation probe\nconst probe = { ruleId: 'synthetic-gated-route' };\n`,
  });

  const errors = validateHttpContracts(config, { declarations });
  assert.ok(
    errors.some((error) => error.includes('declared REST route is missing contract inventory: synthetic-gated-route')),
    errors.join('\n'),
  );
});

// #3905: an emergency-stop declaration must be backed by the shared gate. These
// probes make the declaration a contract rather than a comment.
test('a declared emergency stop whose owner never calls the gate fails the check', () => {
  const config = structuredClone(loadConfig());
  const family = config.contracts.find((item) => item.routeIds.includes('workflow-ask'));
  family.response.emergencyStop = {
    enforced: true,
    status: 423,
    code: 'EMERGENCY_STOPPED',
    owner: 'lib/http/emergency-stop-gate.js',
  };

  const errors = validateHttpContracts(config, {
    readFile(file, encoding) {
      const source = fs.readFileSync(file, encoding);
      if (file.endsWith(path.join('lib', 'http', 'read-workflow-actions.js'))) {
        return source.replaceAll('emergencyStopRefusal', 'gate_removed');
      }
      return source;
    },
  });
  assert.ok(
    errors.some((error) => error.includes('workflow-ask declares emergencyStop but')
      && error.includes('never calls emergencyStopRefusal')),
    errors.join('\n'),
  );
});

test('an emergency-stop declaration without enforced: true fails the check', () => {
  const config = structuredClone(loadConfig());
  const family = config.contracts.find((item) => item.routeIds.includes('workflow-ask'));
  family.response.emergencyStop = {
    enforced: false,
    status: 423,
    code: 'EMERGENCY_STOPPED',
    owner: 'lib/http/emergency-stop-gate.js',
  };
  const errors = validateHttpContracts(config);
  assert.ok(
    errors.some((error) => error.includes('workflow-ask emergencyStop declaration must set enforced: true')),
    errors.join('\n'),
  );
});

test('an emergency-stop declaration with a drifted refusal shape fails the check', () => {
  const cases = [
    { status: 200, field: 'status: 423' },
    { code: 'STOPPED', field: 'code: EMERGENCY_STOPPED' },
    { scope: 'agent', field: 'scope: workspace' },
  ];
  for (const { field, ...drift } of cases) {
    const config = structuredClone(loadConfig());
    const family = config.contracts.find((item) => item.routeIds.includes('workflow-ask'));
    family.response.emergencyStop = {
      enforced: true,
      status: 423,
      code: 'EMERGENCY_STOPPED',
      scope: 'workspace',
      owner: 'lib/http/emergency-stop-gate.js',
      ...drift,
    };
    const errors = validateHttpContracts(config);
    assert.ok(
      errors.some((error) => error.includes(`workflow-ask emergencyStop declaration must set ${field}`)),
      `${field} drift must be rejected, got: ${errors.join('\n')}`,
    );
  }
});

test('the shipped inventory declares the emergency stop on every HTTP read surface', () => {
  const config = loadConfig();
  const gated = [];
  for (const family of config.contracts) {
    if (family.response?.emergencyStop) gated.push(family.family);
  }
  for (const family of ['v2-verify', 'workflow-read-actions', 'workflow-learn', 'legacy-core-post', 'answer']) {
    assert.ok(gated.includes(family), `${family} must declare the emergency stop`);
  }
  const legacy = config.contracts.find((item) => item.family === 'legacy-core-post');
  assert.deepEqual(legacy.response.emergencyStop.routeIds, ['llm-sor', 'dogrula', 'verify']);
});

