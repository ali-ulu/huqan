'use strict';

function pointer(root, ref) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    throw new Error('unsupported schema ref: ' + String(ref));
  }
  return ref.slice(2).split('/').reduce((node, token) => {
    const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
    return node && node[key];
  }, root);
}

function matchesType(value, type) {
  if (type === 'object') return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  if (type === 'array') return Array.isArray(value);
  if (type === 'string') return typeof value === 'string';
  if (type === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (type === 'integer') return Number.isInteger(value);
  if (type === 'boolean') return typeof value === 'boolean';
  if (type === 'null') return value === null;
  return true;
}

function validateSchema(value, node, root = node, at = '<root>') {
  if (!node || typeof node !== 'object') return [];

  if (node.$ref) {
    const target = pointer(root, node.$ref);
    if (!target) return [at + ': unresolved ref ' + node.$ref];
    return validateSchema(value, target, root, at);
  }

  const errors = [];

  if (Array.isArray(node.oneOf)) {
    const matches = node.oneOf.filter((choice) => validateSchema(value, choice, root, at).length === 0);
    if (matches.length !== 1) errors.push(at + ': matched ' + matches.length + ' of oneOf');
  }

  const types = Array.isArray(node.type) ? node.type : (node.type ? [node.type] : []);
  if (types.length > 0 && !types.some((type) => matchesType(value, type))) {
    errors.push(at + ': expected ' + types.join('|'));
    return errors;
  }

  if (Object.prototype.hasOwnProperty.call(node, 'const') && value !== node.const) {
    errors.push(at + ': const mismatch');
  }
  if (Array.isArray(node.enum) && !node.enum.some((item) => Object.is(item, value))) {
    errors.push(at + ': enum mismatch');
  }

  if (typeof value === 'string') {
    if (node.minLength !== undefined && value.length < node.minLength) errors.push(at + ': too short');
    if (node.pattern && !new RegExp(node.pattern).test(value)) errors.push(at + ': pattern mismatch');
    if (node.format === 'date-time' && Number.isNaN(Date.parse(value))) errors.push(at + ': invalid date-time');
  }

  if (typeof value === 'number' && node.minimum !== undefined && value < node.minimum) {
    errors.push(at + ': below minimum');
  }

  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) errors.push(at + ': too few items');
    if (node.items && typeof node.items === 'object') {
      value.forEach((item, index) => {
        errors.push(...validateSchema(item, node.items, root, at + '[' + index + ']'));
      });
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const required of node.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, required)) {
        errors.push(at + ': missing "' + required + '"');
      }
    }

    const properties = node.properties || {};
    for (const [key, child] of Object.entries(properties)) {
      if (Object.prototype.hasOwnProperty.call(value, key)) {
        errors.push(...validateSchema(value[key], child, root, at + '.' + key));
      }
    }

    for (const key of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) continue;
      if (node.additionalProperties === false) {
        errors.push(at + ': unexpected "' + key + '"');
      } else if (node.additionalProperties && typeof node.additionalProperties === 'object') {
        errors.push(...validateSchema(value[key], node.additionalProperties, root, at + '.' + key));
      }
    }
  }

  return errors;
}

module.exports = { validateSchema };
