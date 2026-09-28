'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  RULE_IR_SCHEMA_VERSION,
  ERROR_CODES,
  variable,
  constant,
  atom,
  createRule,
  serializeRule,
  parseRule,
} = require('../lib/inference-rule-ir');

function exampleRule() {
  const X = variable('X');
  const Y = variable('Y');
  const Z = variable('Z');
  return createRule({
    id: 'rule:causal-type:1',
    head: atom('affects', [X, Z]),
    body: [
      atom('CAUSES', [X, Y]),
      atom('is_a', [Y, Z]),
    ],
    constraints: [
      atom('is_a', [Z, constant('concept')]),
    ],
  });
}

test('rule IR represents variables in body/head and round-trips deterministically', () => {
  const rule = exampleRule();

  assert.equal(rule.schemaVersion, RULE_IR_SCHEMA_VERSION);
  assert.equal(rule.id, 'rule:causal-type:1');
  assert.equal(rule.body[0].args[0].kind, 'variable');
  assert.equal(rule.head.args[1].name, 'Z');

  const serialized = serializeRule(rule);
  const parsed = parseRule(serialized);

  assert.deepEqual(parsed, rule);
  assert.equal(serializeRule(parsed), serialized);
  assert.ok(Object.isFrozen(parsed));
  assert.ok(Object.isFrozen(parsed.body));
  assert.ok(Object.isFrozen(parsed.body[0]));
  assert.ok(Object.isFrozen(parsed.body[0].args));
});

test('serialization is byte-stable across object key insertion order', () => {
  const rule = exampleRule();
  const shuffled = {
    constraints: rule.constraints.map((item) => ({
      args: item.args.map((term) => term.kind === 'variable'
        ? { name: term.name, kind: term.kind }
        : { value: term.value, kind: term.kind }),
      predicate: item.predicate,
    })),
    body: rule.body.map((item) => ({
      args: item.args.map((term) => term.kind === 'variable'
        ? { name: term.name, kind: term.kind }
        : { value: term.value, kind: term.kind }),
      predicate: item.predicate,
    })),
    head: {
      args: rule.head.args.map((term) => ({ name: term.name, kind: term.kind })),
      predicate: rule.head.predicate,
    },
    id: rule.id,
    schemaVersion: RULE_IR_SCHEMA_VERSION,
  };

  assert.equal(
    serializeRule(parseRule(shuffled)),
    serializeRule(rule),
  );
});

test('constant and variable stay distinct even with the same surface text', () => {
  const asVariable = variable('X');
  const asConstant = constant('X');

  assert.notDeepEqual(asVariable, asConstant);
  assert.equal(asVariable.kind, 'variable');
  assert.equal(asConstant.kind, 'constant');
});

test('rule id survives serialize/parse round-trip unchanged', () => {
  const rule = exampleRule();
  const parsed = parseRule(serializeRule(rule));
  assert.equal(parsed.id, rule.id);
});

test('invalid predicate shape fails closed with a deterministic code', () => {
  assert.throws(
    () => atom('bad predicate', [variable('X')]),
    (error) => error && error.code === ERROR_CODES.PREDICATE_INVALID,
  );
});

test('ambiguous term objects with extra fields are rejected', () => {
  assert.throws(
    () => atom('is_a', [{ kind: 'constant', value: 'X', name: 'X' }]),
    (error) => error && error.code === ERROR_CODES.TERM_SHAPE_INVALID,
  );
});

test('unsupported schema versions are rejected on parse', () => {
  const value = JSON.parse(serializeRule(exampleRule()));
  value.schemaVersion = 'huqan.rule-ir.v999';

  assert.throws(
    () => parseRule(value),
    (error) => error && error.code === ERROR_CODES.SCHEMA_VERSION_UNSUPPORTED,
  );
});

test('empty rule body is rejected instead of becoming an implicit fact', () => {
  assert.throws(
    () => createRule({
      id: 'rule:empty',
      head: atom('related_to', [constant('a'), constant('b')]),
      body: [],
    }),
    (error) => error && error.code === ERROR_CODES.BODY_REQUIRED,
  );
});

test('malformed serialized JSON is rejected with a parse-specific code', () => {
  assert.throws(
    () => parseRule('{not-json'),
    (error) => error && error.code === ERROR_CODES.PARSE_INVALID_JSON,
  );
});
