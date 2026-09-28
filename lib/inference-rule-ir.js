'use strict';

const { isPlainObject } = require('./is-plain-object');
const { stableStringify } = require('./receipt/canonical-receipt');

const RULE_IR_SCHEMA_VERSION = 'huqan.rule-ir.v1';
const TERM_KINDS = Object.freeze({
  CONSTANT: 'constant',
  VARIABLE: 'variable',
});

const ERROR_CODES = Object.freeze({
  RULE_SHAPE_INVALID: 'RULE_IR_RULE_SHAPE_INVALID',
  RULE_ID_INVALID: 'RULE_IR_RULE_ID_INVALID',
  SCHEMA_VERSION_UNSUPPORTED: 'RULE_IR_SCHEMA_VERSION_UNSUPPORTED',
  BODY_REQUIRED: 'RULE_IR_BODY_REQUIRED',
  BODY_TOO_LARGE: 'RULE_IR_BODY_TOO_LARGE',
  CONSTRAINTS_TOO_LARGE: 'RULE_IR_CONSTRAINTS_TOO_LARGE',
  ATOM_SHAPE_INVALID: 'RULE_IR_ATOM_SHAPE_INVALID',
  PREDICATE_INVALID: 'RULE_IR_PREDICATE_INVALID',
  ARGUMENTS_INVALID: 'RULE_IR_ARGUMENTS_INVALID',
  TERM_SHAPE_INVALID: 'RULE_IR_TERM_SHAPE_INVALID',
  VARIABLE_NAME_INVALID: 'RULE_IR_VARIABLE_NAME_INVALID',
  CONSTANT_VALUE_INVALID: 'RULE_IR_CONSTANT_VALUE_INVALID',
  PARSE_INVALID_JSON: 'RULE_IR_PARSE_INVALID_JSON',
});

const MAX_RULE_ID_LENGTH = 256;
const MAX_PREDICATE_LENGTH = 128;
const MAX_ARGUMENTS = 8;
const MAX_BODY_ATOMS = 64;
const MAX_CONSTRAINT_ATOMS = 32;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

class RuleIRError extends TypeError {
  constructor(code, message) {
    super(message);
    this.name = 'RuleIRError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new RuleIRError(code, message);
}

function exactKeys(value, keys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function optionalExactKeys(value, required, optional = []) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  if (required.some((key) => !Object.hasOwn(value, key))) return false;
  return keys.every((key) => required.includes(key) || optional.includes(key));
}

function assertText(value, { code, label, maxLength, allowWhitespace = true }) {
  if (typeof value !== 'string' || value.length === 0 || value.trim().length === 0) {
    fail(code, `${label} must be a non-empty string`);
  }
  if (value.length > maxLength) {
    fail(code, `${label} exceeds the maximum length of ${maxLength}`);
  }
  if (CONTROL_CHARACTERS.test(value)) {
    fail(code, `${label} must not contain control characters`);
  }
  if (!allowWhitespace && /\s/.test(value)) {
    fail(code, `${label} must not contain whitespace`);
  }
  return value;
}

function normalizeVariable(input) {
  if (!exactKeys(input, ['kind', 'name']) || input.kind !== TERM_KINDS.VARIABLE) {
    fail(
      ERROR_CODES.TERM_SHAPE_INVALID,
      'variable term must contain exactly { kind: "variable", name }',
    );
  }
  const name = assertText(input.name, {
    code: ERROR_CODES.VARIABLE_NAME_INVALID,
    label: 'variable.name',
    maxLength: 128,
    allowWhitespace: false,
  });
  if (!VARIABLE_NAME.test(name)) {
    fail(
      ERROR_CODES.VARIABLE_NAME_INVALID,
      'variable.name must match /^[A-Za-z_][A-Za-z0-9_]*$/',
    );
  }
  return Object.freeze({ kind: TERM_KINDS.VARIABLE, name });
}

function normalizeConstant(input) {
  if (!exactKeys(input, ['kind', 'value']) || input.kind !== TERM_KINDS.CONSTANT) {
    fail(
      ERROR_CODES.TERM_SHAPE_INVALID,
      'constant term must contain exactly { kind: "constant", value }',
    );
  }
  const value = assertText(input.value, {
    code: ERROR_CODES.CONSTANT_VALUE_INVALID,
    label: 'constant.value',
    maxLength: 2048,
    allowWhitespace: true,
  });
  return Object.freeze({ kind: TERM_KINDS.CONSTANT, value });
}

function normalizeTerm(input) {
  if (!isPlainObject(input)) {
    fail(ERROR_CODES.TERM_SHAPE_INVALID, 'term must be a plain object');
  }
  if (input.kind === TERM_KINDS.VARIABLE) return normalizeVariable(input);
  if (input.kind === TERM_KINDS.CONSTANT) return normalizeConstant(input);
  fail(
    ERROR_CODES.TERM_SHAPE_INVALID,
    'term.kind must be "variable" or "constant"',
  );
}

function normalizeAtom(input) {
  if (!exactKeys(input, ['predicate', 'args'])) {
    fail(
      ERROR_CODES.ATOM_SHAPE_INVALID,
      'atom must contain exactly { predicate, args }',
    );
  }
  const predicate = assertText(input.predicate, {
    code: ERROR_CODES.PREDICATE_INVALID,
    label: 'atom.predicate',
    maxLength: MAX_PREDICATE_LENGTH,
    allowWhitespace: false,
  });
  if (!Array.isArray(input.args) || input.args.length < 1 || input.args.length > MAX_ARGUMENTS) {
    fail(
      ERROR_CODES.ARGUMENTS_INVALID,
      `atom.args must contain between 1 and ${MAX_ARGUMENTS} terms`,
    );
  }
  const args = Object.freeze(input.args.map(normalizeTerm));
  return Object.freeze({ predicate, args });
}

function normalizeAtomList(value, { label, required, maxLength, errorCode }) {
  if (!Array.isArray(value) || (required && value.length === 0)) {
    fail(errorCode, `${label} must be ${required ? 'a non-empty' : 'an'} array`);
  }
  if (value.length > maxLength) {
    fail(errorCode, `${label} exceeds the maximum length of ${maxLength}`);
  }
  return Object.freeze(value.map(normalizeAtom));
}

function normalizeRule(input, { requireSchemaVersion = false } = {}) {
  if (!optionalExactKeys(
    input,
    ['id', 'head', 'body'],
    ['schemaVersion', 'constraints'],
  )) {
    fail(
      ERROR_CODES.RULE_SHAPE_INVALID,
      'rule must contain id, head and body, with optional schemaVersion and constraints',
    );
  }

  if (requireSchemaVersion && input.schemaVersion !== RULE_IR_SCHEMA_VERSION) {
    fail(
      ERROR_CODES.SCHEMA_VERSION_UNSUPPORTED,
      `rule.schemaVersion must be ${RULE_IR_SCHEMA_VERSION}`,
    );
  }
  if (
    Object.hasOwn(input, 'schemaVersion')
    && input.schemaVersion !== RULE_IR_SCHEMA_VERSION
  ) {
    fail(
      ERROR_CODES.SCHEMA_VERSION_UNSUPPORTED,
      `unsupported rule.schemaVersion: ${String(input.schemaVersion)}`,
    );
  }

  const id = assertText(input.id, {
    code: ERROR_CODES.RULE_ID_INVALID,
    label: 'rule.id',
    maxLength: MAX_RULE_ID_LENGTH,
    allowWhitespace: true,
  });
  const head = normalizeAtom(input.head);
  const body = normalizeAtomList(input.body, {
    label: 'rule.body',
    required: true,
    maxLength: MAX_BODY_ATOMS,
    errorCode: input.body && input.body.length > MAX_BODY_ATOMS
      ? ERROR_CODES.BODY_TOO_LARGE
      : ERROR_CODES.BODY_REQUIRED,
  });
  const constraints = normalizeAtomList(input.constraints || [], {
    label: 'rule.constraints',
    required: false,
    maxLength: MAX_CONSTRAINT_ATOMS,
    errorCode: ERROR_CODES.CONSTRAINTS_TOO_LARGE,
  });

  return Object.freeze({
    schemaVersion: RULE_IR_SCHEMA_VERSION,
    id,
    head,
    body,
    constraints,
  });
}

function variable(name) {
  return normalizeVariable({ kind: TERM_KINDS.VARIABLE, name });
}

function constant(value) {
  return normalizeConstant({ kind: TERM_KINDS.CONSTANT, value });
}

function atom(predicate, args) {
  return normalizeAtom({ predicate, args });
}

function createRule(input) {
  return normalizeRule(input);
}

function serializeRule(rule) {
  return stableStringify(normalizeRule(rule, { requireSchemaVersion: true }));
}

function parseRule(serialized) {
  let value = serialized;
  if (typeof serialized === 'string') {
    try {
      value = JSON.parse(serialized);
    } catch (_) {
      fail(ERROR_CODES.PARSE_INVALID_JSON, 'serialized rule is not valid JSON');
    }
  }
  return normalizeRule(value, { requireSchemaVersion: true });
}

module.exports = {
  RULE_IR_SCHEMA_VERSION,
  ERROR_CODES,
  variable,
  constant,
  atom,
  createRule,
  serializeRule,
  parseRule,
};
