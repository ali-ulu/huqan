'use strict';

/**
 * Runtime conformance of a tool result against the tool's declared
 * `outputSchema` (#3483).
 *
 * MCP 2025-06-18 says a server that declares an output schema MUST return
 * structured content that conforms to it. HUQAN declared one for every tool
 * but never checked a result against it, so a handler drifting from its
 * contract reached the client as if it were the documented shape.
 *
 * The validator here covers exactly the keyword set the declared schemas use.
 * It is deliberately not the HTTP request validator: that one ignores
 * `anyOf`, `null`, `boolean` and type unions, which output schemas use
 * hundreds of times, so reusing it would pass almost anything. A keyword this
 * module does not know is a reason to refuse, never to skip: an unknown
 * constraint cannot be shown to hold.
 */

const { isPlainObject } = require('../is-plain-object');

const SUPPORTED_KEYWORDS = Object.freeze(new Set([
  '$id', 'type', 'anyOf', 'const', 'enum',
  'properties', 'required', 'additionalProperties',
  'items', 'maxItems',
  'minLength', 'maxLength', 'pattern',
  'minimum', 'maximum',
  'description', 'title',
]));

const TYPE_CHECKS = Object.freeze({
  object: isPlainObject,
  array: Array.isArray,
  string: value => typeof value === 'string',
  boolean: value => typeof value === 'boolean',
  null: value => value === null,
  integer: Number.isInteger,
  number: Number.isFinite,
});

function matchesType(value, type) {
  return Object.hasOwn(TYPE_CHECKS, type) && TYPE_CHECKS[type](value);
}

function unsupportedKeyword(schema) {
  return Object.keys(schema).find(key => !SUPPORTED_KEYWORDS.has(key)) || null;
}

function checkType(value, schema, at) {
  if (!Object.hasOwn(schema, 'type')) return null;
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  return types.some(type => matchesType(value, type))
    ? null
    : `${at} must be of type ${types.join('|')}`;
}

function checkObject(value, schema, at) {
  const properties = isPlainObject(schema.properties) ? schema.properties : {};
  for (const key of Array.isArray(schema.required) ? schema.required : []) {
    if (!Object.hasOwn(value, key)) return `${at}.${key} is required`;
  }
  for (const key of Object.keys(value)) {
    if (Object.hasOwn(properties, key)) {
      const error = conformanceError(value[key], properties[key], `${at}.${key}`);
      if (error) return error;
    } else if (schema.additionalProperties === false) {
      return `${at}.${key} is not allowed`;
    } else if (isPlainObject(schema.additionalProperties)) {
      const error = conformanceError(value[key], schema.additionalProperties, `${at}.${key}`);
      if (error) return error;
    }
  }
  return null;
}

function checkArray(value, schema, at) {
  if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
    return `${at} must contain at most ${schema.maxItems} items`;
  }
  if (!schema.items) return null;
  for (let index = 0; index < value.length; index += 1) {
    const error = conformanceError(value[index], schema.items, `${at}[${index}]`);
    if (error) return error;
  }
  return null;
}

function checkString(value, schema, at) {
  if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return `${at} is too short`;
  if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return `${at} is too long`;
  if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) {
    return `${at} does not match its pattern`;
  }
  return null;
}

function checkNumber(value, schema, at) {
  if (Number.isFinite(schema.minimum) && value < schema.minimum) return `${at} must be at least ${schema.minimum}`;
  if (Number.isFinite(schema.maximum) && value > schema.maximum) return `${at} must be at most ${schema.maximum}`;
  return null;
}

/**
 * The first way `value` fails `schema`, as a path-qualified sentence, or null
 * when it conforms. The sentence names the location and the rule, never the
 * offending value: a result that failed its contract is not echoed back.
 */
function conformanceError(value, schema, at = 'structuredContent') {
  if (schema === true) return null;
  if (!isPlainObject(schema)) return `${at} has no usable schema`;
  const unknown = unsupportedKeyword(schema);
  if (unknown) return `${at} uses unsupported schema keyword ${unknown}`;

  if (Array.isArray(schema.anyOf)) {
    if (!schema.anyOf.some(branch => conformanceError(value, branch, at) === null)) {
      return `${at} matches none of its allowed shapes`;
    }
  }
  if (Object.hasOwn(schema, 'const') && !Object.is(value, schema.const)) return `${at} must equal its constant`;
  if (Array.isArray(schema.enum) && !schema.enum.some(item => Object.is(item, value))) {
    return `${at} must be one of the documented values`;
  }
  const typeError = checkType(value, schema, at);
  if (typeError) return typeError;

  if (isPlainObject(value)) return checkObject(value, schema, at);
  if (Array.isArray(value)) return checkArray(value, schema, at);
  if (typeof value === 'string') return checkString(value, schema, at);
  if (typeof value === 'number') return checkNumber(value, schema, at);
  return null;
}

/**
 * Every keyword a schema tree uses that this module cannot enforce. Empty for
 * every declared output schema; the characterisation test pins that, so a new
 * keyword in a schema fails a test instead of disabling a check at runtime.
 */
function unsupportedKeywords(schema, found = new Set()) {
  if (Array.isArray(schema)) {
    for (const item of schema) unsupportedKeywords(item, found);
    return found;
  }
  if (!isPlainObject(schema)) return found;
  for (const key of Object.keys(schema)) if (!SUPPORTED_KEYWORDS.has(key)) found.add(key);
  if (isPlainObject(schema.properties)) {
    for (const child of Object.values(schema.properties)) unsupportedKeywords(child, found);
  }
  for (const key of ['items', 'anyOf', 'additionalProperties']) {
    if (schema[key] && typeof schema[key] === 'object') unsupportedKeywords(schema[key], found);
  }
  return found;
}

module.exports = Object.freeze({
  SUPPORTED_KEYWORDS,
  conformanceError,
  unsupportedKeywords,
});
