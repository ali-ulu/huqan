'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const fc = require('fast-check');

const { validateSchema } = require('./schema-validator');

const SCHEMA_DIR = path.join(__dirname, '..', '..', 'specs', 'huqan-trust-protocol', '0.2', 'schemas');
const EXPECTED_SCHEMAS = Object.freeze([
  'a2a-trust-evidence.schema.json',
  'agent-identity.schema.json',
  'public-trust-receipt.schema.json',
  'shared-trust-package.schema.json',
]);

const schemaEntries = fs.readdirSync(SCHEMA_DIR)
  .filter((name) => name.endsWith('.json'))
  .map((name) => ({
    name,
    schema: JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8')),
  }))
  .filter(({ schema }) => typeof schema.$schema === 'string');

const invalidRootArb = fc.oneof(
  fc.constant(null),
  fc.boolean(),
  fc.integer(),
  fc.string({ maxLength: 256 }),
  fc.array(fc.jsonValue(), { maxLength: 6 }),
);

test('receipt schema fuzz manifest covers every canonical schema JSON file', () => {
  assert.deepEqual(schemaEntries.map(({ name }) => name).sort(), [...EXPECTED_SCHEMAS].sort());
});

for (const { name, schema } of schemaEntries) {
  test('receipt schema fuzz: ' + name + ' rejects non-object roots', { timeout: 10000 }, () => {
    assert.equal(schema.type, 'object', name + ' must stay object-rooted');
    fc.assert(
      fc.property(invalidRootArb, (value) => {
        assert.notDeepEqual(validateSchema(value, schema), [], name + ' accepted malformed root');
      }),
      { numRuns: 120 },
    );
  });

  test('receipt schema fuzz: ' + name + ' rejects missing required fields and unknown fields', { timeout: 10000 }, () => {
    const required = Array.isArray(schema.required) ? schema.required : [];
    assert.ok(required.length > 0, name + ' must retain required fields');
    assert.equal(schema.additionalProperties, false, name + ' must stay default-deny');

    fc.assert(
      fc.property(fc.constantFrom(...required), fc.jsonValue(), (missing, noise) => {
        const candidate = { __fuzz_extra__: noise };
        delete candidate[missing];
        const errors = validateSchema(candidate, schema);
        assert.ok(
          errors.some((error) => error.includes('missing "' + missing + '"')),
          name + ' did not reject missing ' + missing,
        );
        assert.ok(
          errors.some((error) => error.includes('unexpected "__fuzz_extra__"')),
          name + ' did not reject an unknown field',
        );
      }),
      { numRuns: Math.max(120, required.length * 8) },
    );
  });
}
