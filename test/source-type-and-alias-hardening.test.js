const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  INVALID_SOURCE_TYPE,
  INVALID_SOURCE_TYPE_MAX_CONFIDENCE,
  VALID_SOURCE_TYPES,
  buildProvenance,
} = require('../lib/provenance-ingest');
const { admissionRiskFromConfidence } = require('../lib/background-provenance');
const {
  ALIAS_REGISTRY,
  getDomainRegistry,
  registerAlias,
  resolveEntity,
} = require('../lib/entity-resolution');

function provenanceFor(sourceType, extra = {}) {
  return buildProvenance({
    sourceType,
    sourceRef: 'ref://fixture',
    sourceTitle: 'fixture',
    actor: 'operator',
    workspaceId: 'workspace-alpha',
    ...extra,
  }).provenance;
}

describe('an invalid sourceType is never promoted (#742)', () => {
  it('is not rewritten to a semantically trusted principal', () => {
    const provenance = provenanceFor('llm-custom');
    assert.strictEqual(provenance.sourceType, INVALID_SOURCE_TYPE);
    assert.notStrictEqual(provenance.sourceType, 'system');
    assert.strictEqual(provenance.rejectedSourceType, 'llm-custom');
  });

  it('a misspelling is never more trusted than the type it failed to be', () => {
    for (const valid of VALID_SOURCE_TYPES) {
      const known = provenanceFor(valid);
      const misspelled = provenanceFor(`${valid}-custom`);
      assert.ok(
        misspelled.confidence <= known.confidence,
        `${valid}-custom scored ${misspelled.confidence}, above ${valid} at ${known.confidence}`,
      );
    }
  });

  it('sits below every registered source type', () => {
    const invalid = provenanceFor('totally-made-up');
    for (const valid of VALID_SOURCE_TYPES) {
      assert.ok(
        invalid.confidence < provenanceFor(valid).confidence,
        `invalid scored ${invalid.confidence}, not below ${valid}`,
      );
    }
  });

  it('does not clear the source-based review risk', () => {
    const llm = provenanceFor('llm');
    const spoofed = provenanceFor('llm-custom');
    assert.ok(
      admissionRiskFromConfidence(spoofed.confidence) >= admissionRiskFromConfidence(llm.confidence),
      'the invalid spelling must not receive a more permissive decision',
    );
    assert.ok(admissionRiskFromConfidence(spoofed.confidence) > 0);
  });

  it('caps a caller-supplied confidence too', () => {
    const provenance = provenanceFor('llm-custom', { confidence: 0.99 });
    assert.strictEqual(provenance.confidence, INVALID_SOURCE_TYPE_MAX_CONFIDENCE);
    assert.strictEqual(provenance.confidenceSource, 'invalid_source_type_floor');
  });

  it('warns about the rejection rather than claiming a normalization to system', () => {
    const { warnings } = buildProvenance({
      sourceType: 'llm-custom',
      sourceRef: 'ref://fixture',
      sourceTitle: 'fixture',
      actor: 'operator',
      workspaceId: 'workspace-alpha',
    });
    assert.ok(warnings.some((w) => w.includes('llm-custom') && w.includes(INVALID_SOURCE_TYPE)));
    assert.ok(!warnings.some((w) => w.includes('normalized to system')));
  });

  it('valid source types keep their policy weights', () => {
    assert.strictEqual(provenanceFor('llm').confidence, 0.4);
    assert.strictEqual(provenanceFor('user').confidence, 0.9);
    assert.strictEqual(provenanceFor('system').confidence, 0.5);
    assert.strictEqual(provenanceFor('background_inference').confidence, 0.3);
  });

  it('strict mode still rejects outright', () => {
    assert.throws(() => buildProvenance({
      sourceType: 'llm-custom',
      sourceRef: 'ref://fixture',
      sourceTitle: 'fixture',
      actor: 'operator',
      timestamp: new Date().toISOString(),
      confidence: 0.5,
      provenanceId: 'p-1',
      workspaceId: 'workspace-alpha',
    }, { strictProvenance: true }), (error) => error.missing.includes('sourceType'));
  });
});

describe('alias registry is prototype-inert (#748)', () => {
  it('registering a __proto__ domain is rejected and pollutes nothing', () => {
    assert.strictEqual(registerAlias('__proto__', 'polluted', 'yes'), false);
    assert.strictEqual(({}).polluted, undefined);
    assert.strictEqual(Object.prototype.polluted, undefined);
  });

  it('rejects constructor and prototype in either position', () => {
    for (const name of ['constructor', 'prototype', '__proto__']) {
      assert.strictEqual(registerAlias(name, 'alias', 'canonical'), false, `domain ${name}`);
      assert.strictEqual(registerAlias('aviation', name, 'canonical'), false, `alias ${name}`);
    }
    assert.strictEqual(({}).canonical, undefined);
    assert.strictEqual(typeof ({}).constructor, 'function', 'constructor must be untouched');
  });

  it('getDomainRegistry finds no registry for a prototype name', () => {
    for (const name of ['__proto__', 'constructor', 'prototype']) {
      assert.strictEqual(getDomainRegistry(name), null, name);
    }
    assert.ok(getDomainRegistry('aviation'));
  });

  it('storage carries no prototype', () => {
    assert.strictEqual(Object.getPrototypeOf(ALIAS_REGISTRY), null);
    for (const registry of Object.values(ALIAS_REGISTRY)) {
      assert.strictEqual(Object.getPrototypeOf(registry), null);
    }
  });

  it('an alias named after an inherited member cannot resolve by inheritance', () => {
    const result = resolveEntity('toString', { domain: 'aviation' });
    assert.strictEqual(result.matched, false);
    assert.ok(!result.canonical);
  });

  it('ordinary registration and resolution are unchanged', () => {
    assert.strictEqual(resolveEntity('b737', { domain: 'aviation' }).canonical, 'boeing_737');
    assert.strictEqual(registerAlias('aviation', 'a350', 'airbus_a350'), true);
    assert.strictEqual(resolveEntity('a350', { domain: 'aviation' }).canonical, 'airbus_a350');
    assert.strictEqual(registerAlias('aviation', 'a350', 'airbus_a350'), false, 're-registering is a no-op');
    assert.strictEqual(registerAlias('brand-new-domain', 'x', 'canonical_x'), true);
    assert.strictEqual(resolveEntity('x', { domain: 'brand-new-domain' }).canonical, 'canonical_x');
  });
});
