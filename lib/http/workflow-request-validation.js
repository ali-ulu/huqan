'use strict';

const { httpRequestSchemaForWorkflow } = require('../workflow-contract');

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function display(value) {
  return typeof value === 'string' ? JSON.stringify(value) : JSON.stringify(value);
}

function validateJsonSchema(value, schema, path = 'body') {
  if (!schema || typeof schema !== 'object') return null;

  if (Object.hasOwn(schema, 'const') && !Object.is(value, schema.const)) {
    return `${path} must equal ${display(schema.const)}.`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(item => Object.is(item, value))) {
    return `${path} must be one of the documented values.`;
  }

  if (schema.type === 'object') {
    if (!isObject(value)) return `${path} must be an object.`;
    const properties = schema.properties || {};
    for (const key of schema.required || []) {
      if (!Object.hasOwn(value, key)) return `${path}.${key} is required.`;
    }
    for (const key of Object.keys(value)) {
      if (schema.additionalProperties === false && !Object.hasOwn(properties, key)) {
        return `${path}.${key} is not allowed.`;
      }
      if (Object.hasOwn(properties, key)) {
        const error = validateJsonSchema(value[key], properties[key], `${path}.${key}`);
        if (error) return error;
      }
    }
    return null;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${path} must be an array.`;
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) {
      return `${path} must contain at most ${schema.maxItems} items.`;
    }
    if (schema.items) {
      for (let index = 0; index < value.length; index += 1) {
        const error = validateJsonSchema(value[index], schema.items, `${path}[${index}]`);
        if (error) return error;
      }
    }
    return null;
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') return `${path} must be a string.`;
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) return `${path} is too short.`;
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) return `${path} is too long.`;
    return null;
  }

  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) return `${path} must be an integer.`;
  } else if (schema.type === 'number') {
    if (!Number.isFinite(value)) return `${path} must be a number.`;
  }
  if ((schema.type === 'integer' || schema.type === 'number') && Number.isFinite(schema.minimum) && value < schema.minimum) {
    return `${path} must be at least ${schema.minimum}.`;
  }
  if ((schema.type === 'integer' || schema.type === 'number') && Number.isFinite(schema.maximum) && value > schema.maximum) {
    return `${path} must be at most ${schema.maximum}.`;
  }
  return null;
}

function validateWorkflowHttpRequest(workflowId, input) {
  return validateJsonSchema(input, httpRequestSchemaForWorkflow(workflowId));
}

module.exports = { validateJsonSchema, validateWorkflowHttpRequest };
