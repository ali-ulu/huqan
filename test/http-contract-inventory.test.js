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
