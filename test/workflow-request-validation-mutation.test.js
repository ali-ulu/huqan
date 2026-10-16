'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateJsonSchema } = require('../lib/http/workflow-request-validation');

test('JSON schema validator pins const and enum semantics', () => {
  assert.equal(validateJsonSchema('x', null), null);
  assert.equal(validateJsonSchema('x', { const: 'x' }), null);
  assert.equal(validateJsonSchema('y', { const: 'x' }), 'body must equal "x".');
  assert.equal(validateJsonSchema(2, { enum: [1, 2, 3] }), null);
  assert.equal(validateJsonSchema(4, { enum: [1, 2, 3] }), 'body must be one of the documented values.');
});

test('JSON schema validator pins object shape, required keys, extras, and recursion', () => {
  const schema = {
    type: 'object',
    required: ['name'],
    additionalProperties: false,
    properties: {
      name: { type: 'string', minLength: 2, maxLength: 4 },
      nested: {
        type: 'object',
        required: ['count'],
        additionalProperties: false,
        properties: { count: { type: 'integer', minimum: 1, maximum: 3 } },
      },
    },
  };

  assert.equal(validateJsonSchema(null, schema), 'body must be an object.');
  assert.equal(validateJsonSchema([], schema), 'body must be an object.');
  assert.equal(validateJsonSchema({}, schema), 'body.name is required.');
  assert.equal(validateJsonSchema({ name: 'ab', extra: true }, schema), 'body.extra is not allowed.');
  assert.equal(validateJsonSchema({ name: 'a' }, schema), 'body.name is too short.');
  assert.equal(validateJsonSchema({ name: 'abcde' }, schema), 'body.name is too long.');
  assert.equal(validateJsonSchema({ name: 'ab', nested: {} }, schema), 'body.nested.count is required.');
  assert.equal(validateJsonSchema({ name: 'ab', nested: { count: 0 } }, schema), 'body.nested.count must be at least 1.');
  assert.equal(validateJsonSchema({ name: 'ab', nested: { count: 4 } }, schema), 'body.nested.count must be at most 3.');
  assert.equal(validateJsonSchema({ name: 'ab', nested: { count: 2, extra: 1 } }, schema), 'body.nested.extra is not allowed.');
  assert.equal(validateJsonSchema({ name: 'ab', nested: { count: 2 } }, schema), null);

  assert.equal(validateJsonSchema({ arbitrary: true }, { type: 'object' }), null);
});

test('JSON schema validator pins arrays and indexed child errors', () => {
  const schema = { type: 'array', maxItems: 2, items: { type: 'string', minLength: 2 } };
  assert.equal(validateJsonSchema({}, schema), 'body must be an array.');
  assert.equal(validateJsonSchema(['aa', 'bb', 'cc'], schema), 'body must contain at most 2 items.');
  assert.equal(validateJsonSchema(['aa', 'b'], schema), 'body[1] is too short.');
  assert.equal(validateJsonSchema(['aa', 'bb'], schema), null);
  assert.equal(validateJsonSchema([], { type: 'array' }), null);
});

test('JSON schema validator pins scalar type and numeric boundaries', () => {
  assert.equal(validateJsonSchema(1, { type: 'string' }), 'body must be a string.');
  assert.equal(validateJsonSchema('', { type: 'string', minLength: 0, maxLength: 0 }), null);

  assert.equal(validateJsonSchema(1.5, { type: 'integer' }), 'body must be an integer.');
  assert.equal(validateJsonSchema(1, { type: 'integer', minimum: 1, maximum: 2 }), null);
  assert.equal(validateJsonSchema(0, { type: 'integer', minimum: 1 }), 'body must be at least 1.');
  assert.equal(validateJsonSchema(3, { type: 'integer', maximum: 2 }), 'body must be at most 2.');

  assert.equal(validateJsonSchema(Number.NaN, { type: 'number' }), 'body must be a number.');
  assert.equal(validateJsonSchema(Number.POSITIVE_INFINITY, { type: 'number' }), 'body must be a number.');
  assert.equal(validateJsonSchema('2', { type: 'number' }), 'body must be a number.');
  assert.equal(validateJsonSchema(1.5, { type: 'number', minimum: 1.5, maximum: 1.5 }), null);
  assert.equal(validateJsonSchema(1.4, { type: 'number', minimum: 1.5 }), 'body must be at least 1.5.');
  assert.equal(validateJsonSchema(1.6, { type: 'number', maximum: 1.5 }), 'body must be at most 1.5.');

  assert.equal(validateJsonSchema('anything', { type: 'unknown' }), null);
});
