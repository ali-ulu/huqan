'use strict';

const fs = require('node:fs');
const path = require('node:path');

const STATUS = Object.freeze({
  COMPLETED: 'COMPLETED',
  NEEDS_HUMAN_DECISION: 'NEEDS_HUMAN_DECISION',
  UNSUPPORTED_TASK: 'UNSUPPORTED_TASK',
});

const SUPPORTED_OPERATIONS = new Set([
  'replace_text',
  'insert_after',
  'json_schema_route_test',
  'rename_identifier',
]);

function cloneFiles(files) {
  return Object.fromEntries(Object.entries(files || {}).map(([filePath, content]) => [filePath, content]));
}

function stableEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unchangedResult(status, reason, files) {
  return {
    status,
    reason,
    changedPaths: [],
    patch: [],
    files: cloneFiles(files),
  };
}

function completedResult(files, patch) {
  return {
    status: STATUS.COMPLETED,
    reason: null,
    changedPaths: patch.map(change => change.path),
    patch,
    files,
  };
}

function pathIsAllowed(filePath, allowedPaths) {
  return allowedPaths.includes(filePath);
}

function validateTask(task) {
  if (!task || typeof task !== 'object') return 'TASK_NOT_OBJECT';
  if (!task.id || !task.level || !task.operation || typeof task.files !== 'object') {
    return 'TASK_CONTRACT_INVALID';
  }
  if (!Array.isArray(task.allowedPaths) || !Array.isArray(task.expectedPatch)) {
    return 'TASK_CONTRACT_INVALID';
  }
  return null;
}

function applySingleChange(files, patch, filePath, nextContent) {
  const before = Object.prototype.hasOwnProperty.call(files, filePath) ? files[filePath] : null;
  files[filePath] = nextContent;
  patch.push({ path: filePath, before, after: nextContent });
}

function applyReplaceText(files, patch, operation, allowedPaths) {
  const { path: filePath, find, replace } = operation;
  if (!pathIsAllowed(filePath, allowedPaths) || typeof files[filePath] !== 'string') {
    return 'PATH_NOT_ALLOWED_OR_MISSING';
  }
  if (typeof find !== 'string' || typeof replace !== 'string') return 'OPERATION_INVALID';
  const occurrences = files[filePath].split(find).length - 1;
  if (occurrences !== 1) return 'REPLACEMENT_NOT_UNIQUE';
  applySingleChange(files, patch, filePath, files[filePath].replace(find, replace));
  return null;
}

function applyInsertAfter(files, patch, operation, allowedPaths) {
  const { path: filePath, anchor, insert } = operation;
  if (!pathIsAllowed(filePath, allowedPaths) || typeof files[filePath] !== 'string') {
    return 'PATH_NOT_ALLOWED_OR_MISSING';
  }
  if (typeof anchor !== 'string' || typeof insert !== 'string') return 'OPERATION_INVALID';
  const occurrences = files[filePath].split(anchor).length - 1;
  if (occurrences !== 1) return 'ANCHOR_NOT_UNIQUE';
  applySingleChange(files, patch, filePath, files[filePath].replace(anchor, `${anchor}${insert}`));
  return null;
}

function identifierStart(char) {
  return /[A-Za-z_$]/.test(char || '');
}

function identifierPart(char) {
  return /[A-Za-z0-9_$]/.test(char || '');
}

function renameIdentifier(source, from, to) {
  let output = '';
  let replacements = 0;
  let index = 0;
  let state = 'code';
  let quote = '';

  while (index < source.length) {
    const char = source[index];
    const next = source[index + 1];

    if (state === 'line-comment') {
      output += char;
      index += 1;
      if (char === '\n') state = 'code';
      continue;
    }
    if (state === 'block-comment') {
      output += char;
      index += 1;
      if (char === '*' && next === '/') {
        output += next;
        index += 1;
        state = 'code';
      }
      continue;
    }
    if (state === 'string') {
      output += char;
      index += 1;
      if (char === '\\' && index < source.length) {
        output += source[index];
        index += 1;
      } else if (char === quote) {
        state = 'code';
      }
      continue;
    }

    if (char === '/' && next === '/') {
      output += '//';
      index += 2;
      state = 'line-comment';
      continue;
    }
    if (char === '/' && next === '*') {
      output += '/*';
      index += 2;
      state = 'block-comment';
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      output += char;
      quote = char;
      index += 1;
      state = 'string';
      continue;
    }
    if (identifierStart(char)) {
      let end = index + 1;
      while (identifierPart(source[end])) end += 1;
      const token = source.slice(index, end);
      if (token === from) {
        output += to;
        replacements += 1;
      } else {
        output += token;
      }
      index = end;
      continue;
    }
    output += char;
    index += 1;
  }

  return { source: output, replacements };
}

function applyRenameIdentifier(files, patch, operation, allowedPaths) {
  const { path: filePath, from, to } = operation;
  if (!pathIsAllowed(filePath, allowedPaths) || typeof files[filePath] !== 'string') {
    return 'PATH_NOT_ALLOWED_OR_MISSING';
  }
  if (!identifierStart(from) || !identifierStart(to)) return 'IDENTIFIER_INVALID';
  const renamed = renameIdentifier(files[filePath], from, to);
  if (renamed.replacements === 0) return 'IDENTIFIER_NOT_FOUND';
  applySingleChange(files, patch, filePath, renamed.source);
  return null;
}

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

function applyJsonSchemaRouteTest(files, patch, operation, allowedPaths) {
  const { schemaPath, routePath, testPath } = operation;
  if (!pathIsAllowed(routePath, allowedPaths) || !pathIsAllowed(testPath, allowedPaths)) {
    return 'PATH_NOT_ALLOWED_OR_MISSING';
  }
  if (typeof files[schemaPath] !== 'string') return 'SCHEMA_MISSING';

  let schema;
  try {
    schema = JSON.parse(files[schemaPath]);
  } catch {
    return 'SCHEMA_INVALID';
  }
  if (!schema.route || !schema.route.method || !schema.route.path || !schema.route.handler) {
    return 'SCHEMA_UNSUPPORTED';
  }
  if (typeof schema.required !== 'undefined' && !Array.isArray(schema.required)) {
    return 'SCHEMA_UNSUPPORTED';
  }
  const routeSource = schemaRouteSource(schema);
  const testSource = schemaTestSource(schema, routePath, testPath);
  applySingleChange(files, patch, routePath, routeSource);
  applySingleChange(files, patch, testPath, testSource);
  return null;
}

function runTask(task) {
  const contractError = validateTask(task);
  if (contractError) return unchangedResult(STATUS.UNSUPPORTED_TASK, contractError, task && task.files);
  if (task.requiresHumanDecision === true) {
    return unchangedResult(STATUS.NEEDS_HUMAN_DECISION, 'TASK_REQUIRES_HUMAN_DECISION', task.files);
  }
  if (!SUPPORTED_OPERATIONS.has(task.operation.type)) {
    return unchangedResult(STATUS.UNSUPPORTED_TASK, 'OPERATION_UNSUPPORTED', task.files);
  }

  const files = cloneFiles(task.files);
  const patch = [];
  let error;
  switch (task.operation.type) {
    case 'replace_text':
      error = applyReplaceText(files, patch, task.operation, task.allowedPaths);
      break;
    case 'insert_after':
      error = applyInsertAfter(files, patch, task.operation, task.allowedPaths);
      break;
    case 'json_schema_route_test':
      error = applyJsonSchemaRouteTest(files, patch, task.operation, task.allowedPaths);
      break;
    case 'rename_identifier':
      error = applyRenameIdentifier(files, patch, task.operation, task.allowedPaths);
      break;
    default:
      error = 'OPERATION_UNSUPPORTED';
  }
  if (error) return unchangedResult(STATUS.NEEDS_HUMAN_DECISION, error, task.files);
  if (!stableEqual(patch, task.expectedPatch)) {
    return unchangedResult(STATUS.NEEDS_HUMAN_DECISION, 'EXPECTED_PATCH_MISMATCH', task.files);
  }
  return completedResult(files, patch);
}

function loadTaskFixture(name, fixtureDirectory = path.join(__dirname, '..', 'test', 'fixtures', 'deterministic-tasks')) {
  const fixturePath = path.join(fixtureDirectory, `${name}.json`);
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
}

module.exports = {
  STATUS,
  loadTaskFixture,
  renameIdentifier,
  runTask,
};
