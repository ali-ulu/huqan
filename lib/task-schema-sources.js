'use strict';

// Schema route/test source generators for the deterministic task runner
// (#2250).
//
// Single responsibility: render the route module and its contract test from
// a validated schema object. Pure string transforms; no schema validation,
// no allowlist, no filesystem writes. The runner keeps validation and result
// assembly; this module is never a second authority for them. Parser scope
// is unchanged by this move.

const path = require('node:path');

function schemaRouteSource(schema) {
  const method = String(schema.route.method).toLowerCase();
  const routePath = schema.route.path;
  const handler = schema.route.handler;
  const registerName = `${handler}Route`;
  const required = JSON.stringify(schema.required || []);
  return [
    "'use strict';",
    '',
    `const requiredFields = Object.freeze(${required});`,
    '',
    `function ${registerName}(router, handler) {`,
    `  router.${method}('${routePath}', handler);`,
    '}',
    '',
    `module.exports = { ${registerName}, requiredFields };`,
    '',
  ].join('\n');
}

function schemaTestSource(schema, routePath, testPath) {
  const method = String(schema.route.method).toUpperCase();
  const schemaRoutePath = schema.route.path;
  const required = JSON.stringify(schema.required || []);
  const routeModule = path.posix.relative(path.posix.dirname(testPath), routePath).replace(/\.js$/u, '');
  const routeModuleImport = routeModule.startsWith('.') ? routeModule : `./${routeModule}`;
  return [
    "'use strict';",
    '',
    "const { test } = require('node:test');",
    "const assert = require('node:assert/strict');",
    `const { requiredFields } = require(${JSON.stringify(routeModuleImport)});`,
    '',
    `test('${method} ${schemaRoutePath} exposes schema-required fields', () => {`,
    `  assert.deepEqual(requiredFields, ${required});`,
    '});',
    '',
  ].join('\n');
}

module.exports = { schemaRouteSource, schemaTestSource };
