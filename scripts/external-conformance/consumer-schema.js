'use strict';

const path = require('node:path');
const { CANONICAL_SPEC_ROOT, check, assert, readJson } = require('./consumer-harness');

// External conformance cases: the minimal JSON-schema validator and the V5
// keyword guard. Runs on require, in the order consumer.js requires the
// sections.

function resolveLocalRef(root, ref) {
  return ref.replace(/^#\//, '').split('/').reduce((node, key) => node[key], root);
}

function validateSchema(value, schema, root = schema, at = '<root>') {
  if (schema.$ref) return validateSchema(value, resolveLocalRef(root, schema.$ref), root, at);
  const errors = [];
  const types = schema.type === undefined ? [] : [].concat(schema.type);
  const actual = value === null ? 'null'
    : Array.isArray(value) ? 'array'
      : Number.isInteger(value) ? 'integer' : typeof value;
  if (types.length && !types.includes(actual)
      && !(actual === 'integer' && types.includes('number'))) {
    return [`${at}: expected ${types.join('|')}`];
  }
  if (Object.prototype.hasOwnProperty.call(schema, 'const') && value !== schema.const) {
    errors.push(`${at}: expected const ${JSON.stringify(schema.const)}`);
  }
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at}: not in enum`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      errors.push(`${at}: shorter than minLength ${schema.minLength}`);
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${at}: does not match ${schema.pattern}`);
    }
    if (schema.format === 'date-time'
        && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value)) {
      errors.push(`${at}: invalid date-time`);
    }
  }
  if (typeof value === 'number' && schema.minimum !== undefined && value < schema.minimum) {
    errors.push(`${at}: below minimum ${schema.minimum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      errors.push(`${at}: fewer than ${schema.minItems} items`);
    }
    if (schema.items) value.forEach((item, index) => {
      errors.push(...validateSchema(item, schema.items, root, `${at}[${index}]`));
    });
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        errors.push(`${at}: missing required ${required}`);
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties || {}, key)) {
          errors.push(`${at}: unexpected property ${key}`);
        }
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const [key, item] of Object.entries(value)) {
        if (!Object.prototype.hasOwnProperty.call(schema.properties || {}, key)) {
          errors.push(...validateSchema(item, schema.additionalProperties, root, `${at}.${key}`));
        }
      }
    }
    for (const [key, subschema] of Object.entries(schema.properties || {})) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validateSchema(value[key], subschema, root, `${at}.${key}`));
      }
    }
  }
  if (schema.oneOf) {
    const matches = schema.oneOf.filter((candidate) => (
      validateSchema(value, candidate, root, at).length === 0
    )).length;
    if (matches !== 1) errors.push(`${at}: expected exactly one oneOf match`);
  }
  return errors;
}

const V5_SCHEMAS = Object.fromEntries([
  'shared-trust-package.schema.json',
  'a2a-trust-evidence.schema.json',
  'public-trust-receipt.schema.json',
].map((file) => [file, readJson(path.join(CANONICAL_SPEC_ROOT, 'schemas', file))]));

const SUPPORTED_SCHEMA_KEYWORDS = new Set([
  '$schema', '$id', '$ref', '$defs', '$comment', 'title', 'description', 'type', 'const',
  'enum', 'required', 'properties', 'additionalProperties', 'items', 'minItems', 'minimum',
  'minLength', 'pattern', 'format', 'oneOf',
]);

function unsupportedSchemaKeywords(node, container = '', at = '<root>') {
  if (Array.isArray(node)) return node.flatMap((item, index) => (
    unsupportedSchemaKeywords(item, '', `${at}[${index}]`)
  ));
  if (!node || typeof node !== 'object') return [];
  const errors = [];
  for (const [key, value] of Object.entries(node)) {
    const isSchemaName = container === 'properties' || container === '$defs';
    if (!isSchemaName && !SUPPORTED_SCHEMA_KEYWORDS.has(key)) errors.push(`${at}.${key}`);
    errors.push(...unsupportedSchemaKeywords(value, key, `${at}.${key}`));
  }
  return errors;
}

check('v5', 'packaged V5 schemas use only consumer-supported validation keywords', () => {
  for (const [file, schema] of Object.entries(V5_SCHEMAS)) {
    const unsupported = unsupportedSchemaKeywords(schema);
    assert(unsupported.length === 0, `${file}: unsupported keywords ${unsupported.join(', ')}`);
  }
});

module.exports = { validateSchema, V5_SCHEMAS };
