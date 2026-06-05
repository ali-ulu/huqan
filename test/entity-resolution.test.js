const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  resolveEntity,
  listAliases,
  listDomains,
  normalizeAlias,
} = require('../lib/entity-resolution');

describe('Entity Resolution - normalizeAlias', () => {
  it('trims and lowercases', () => {
    assert.strictEqual(normalizeAlias('  B737  '), 'b737');
    assert.strictEqual(normalizeAlias('Boeing 737'), 'boeing 737');
    assert.strictEqual(normalizeAlias('BOEING-737'), 'boeing-737');
  });

  it('collapses whitespace', () => {
    assert.strictEqual(normalizeAlias('Boeing   737'), 'boeing 737');
    assert.strictEqual(normalizeAlias('Türk   Hava\nYolları'), 'türk hava yolları');
  });

  it('returns empty string for non-string or empty', () => {
    assert.strictEqual(normalizeAlias(''), '');
    assert.strictEqual(normalizeAlias(null), '');
    assert.strictEqual(normalizeAlias(undefined), '');
    assert.strictEqual(normalizeAlias(123), '');
  });
});

describe('Entity Resolution - listDomains', () => {
  it('returns known domains', () => {
    const domains = listDomains();
    assert.ok(domains.includes('aviation'));
    assert.ok(domains.includes('tech'));
    assert.ok(domains.includes('design'));
    assert.strictEqual(domains.length, 3);
  });
});

describe('Entity Resolution - listAliases', () => {
  it('lists aviation aliases', () => {
    const aliases = listAliases('aviation');
    assert.ok(aliases.some((a) => a.alias === 'b737' && a.canonical === 'boeing_737'));
    assert.ok(aliases.some((a) => a.alias === 'thy' && a.canonical === 'turkish_airlines'));
    assert.ok(aliases.some((a) => a.alias === 'ai' && a.canonical === 'air_india'));
  });

  it('lists tech aliases', () => {
    const aliases = listAliases('tech');
    assert.ok(aliases.some((a) => a.alias === 'ai' && a.canonical === 'artificial_intelligence'));
    assert.ok(aliases.some((a) => a.alias === 'ml' && a.canonical === 'machine_learning'));
  });

  it('lists design aliases', () => {
    const aliases = listAliases('design');
    assert.ok(aliases.some((a) => a.alias === 'ai' && a.canonical === 'adobe_illustrator'));
    assert.ok(aliases.some((a) => a.alias === 'ps' && a.canonical === 'adobe_photoshop'));
  });

  it('returns empty for unknown domain', () => {
    assert.deepStrictEqual(listAliases('unknown'), []);
    assert.deepStrictEqual(listAliases(''), []);
    assert.deepStrictEqual(listAliases(null), []);
  });
});

describe('Entity Resolution - resolveEntity with domain', () => {
  it('B737 / Boeing 737 / Boeing-737 resolve to boeing_737 in aviation', () => {
    const r1 = resolveEntity('B737', { domain: 'aviation' });
    assert.deepStrictEqual(r1, {
      matched: true,
      canonical: 'boeing_737',
      domain: 'aviation',
      confidence: 1,
      reason: 'exact_alias',
      aliases: ['b737', 'boeing 737', 'boeing-737'],
    });

    const r2 = resolveEntity('Boeing 737', { domain: 'aviation' });
    assert.strictEqual(r2.canonical, 'boeing_737');
    assert.strictEqual(r2.matched, true);

    const r3 = resolveEntity('Boeing-737', { domain: 'aviation' });
    assert.strictEqual(r3.canonical, 'boeing_737');
    assert.strictEqual(r3.matched, true);
  });

  it('THY / Türk Hava Yolları resolve to turkish_airlines in aviation', () => {
    const r1 = resolveEntity('THY', { domain: 'aviation' });
    assert.strictEqual(r1.canonical, 'turkish_airlines');
    assert.strictEqual(r1.matched, true);

    const r2 = resolveEntity('Türk Hava Yolları', { domain: 'aviation' });
    assert.strictEqual(r2.canonical, 'turkish_airlines');
    assert.strictEqual(r2.matched, true);

    const r3 = resolveEntity('Turkish Airlines', { domain: 'aviation' });
    assert.strictEqual(r3.canonical, 'turkish_airlines');
    assert.strictEqual(r3.matched, true);
  });

  it('AI resolves to air_india in aviation domain', () => {
    const r = resolveEntity('AI', { domain: 'aviation' });
    assert.strictEqual(r.matched, true);
    assert.strictEqual(r.canonical, 'air_india');
    assert.strictEqual(r.domain, 'aviation');
  });

  it('AI resolves to artificial_intelligence in tech domain', () => {
    const r = resolveEntity('AI', { domain: 'tech' });
    assert.strictEqual(r.matched, true);
    assert.strictEqual(r.canonical, 'artificial_intelligence');
    assert.strictEqual(r.domain, 'tech');
  });

  it('AI resolves to adobe_illustrator in design domain', () => {
    const r = resolveEntity('AI', { domain: 'design' });
    assert.strictEqual(r.matched, true);
    assert.strictEqual(r.canonical, 'adobe_illustrator');
    assert.strictEqual(r.domain, 'design');
  });

  it('unknown alias in domain returns matched:false', () => {
    const r = resolveEntity('XYZ123', { domain: 'aviation' });
    assert.strictEqual(r.matched, false);
    assert.strictEqual(r.reason, 'unknown_alias_in_domain');
    assert.strictEqual(r.domain, 'aviation');
  });

  it('case-insensitive domain', () => {
    const r1 = resolveEntity('B737', { domain: 'AVIATION' });
    const r2 = resolveEntity('B737', { domain: 'Aviation' });
    assert.strictEqual(r1.canonical, 'boeing_737');
    assert.strictEqual(r2.canonical, 'boeing_737');
  });

  it('case-insensitive alias', () => {
    const r1 = resolveEntity('b737', { domain: 'aviation' });
    const r2 = resolveEntity('B737', { domain: 'aviation' });
    const r3 = resolveEntity('Boeing 737', { domain: 'aviation' });
    assert.strictEqual(r1.canonical, 'boeing_737');
    assert.strictEqual(r2.canonical, 'boeing_737');
    assert.strictEqual(r3.canonical, 'boeing_737');
  });
});

describe('Entity Resolution - resolveEntity without domain', () => {
  it('AI without domain returns ambiguous', () => {
    const r = resolveEntity('AI');
    assert.strictEqual(r.matched, false);
    assert.strictEqual(r.ambiguous, true);
    assert.ok(r.candidates.includes('air_india'));
    assert.ok(r.candidates.includes('artificial_intelligence'));
    assert.ok(r.candidates.includes('adobe_illustrator'));
    assert.strictEqual(r.reason, 'ambiguous_alias_requires_domain');
  });

  it('B737 without domain resolves uniquely (only in aviation)', () => {
    const r = resolveEntity('B737');
    assert.strictEqual(r.matched, true);
    assert.strictEqual(r.canonical, 'boeing_737');
    assert.strictEqual(r.domain, 'aviation');
    assert.strictEqual(r.reason, 'exact_alias');
  });

  it('THY without domain resolves uniquely (only in aviation)', () => {
    const r = resolveEntity('THY');
    assert.strictEqual(r.matched, true);
    assert.strictEqual(r.canonical, 'turkish_airlines');
    assert.strictEqual(r.domain, 'aviation');
  });

  it('ml without domain resolves uniquely (only in tech)', () => {
    const r = resolveEntity('ml');
    assert.strictEqual(r.matched, true);
    assert.strictEqual(r.canonical, 'machine_learning');
    assert.strictEqual(r.domain, 'tech');
  });

  it('ps without domain resolves uniquely (only in design)', () => {
    const r = resolveEntity('ps');
    assert.strictEqual(r.matched, true);
    assert.strictEqual(r.canonical, 'adobe_photoshop');
    assert.strictEqual(r.domain, 'design');
  });

  it('completely unknown alias returns matched:false', () => {
    const r = resolveEntity('XYZ999');
    assert.strictEqual(r.matched, false);
    assert.strictEqual(r.reason, 'unknown_alias');
    assert.strictEqual(r.ambiguous, undefined);
  });

  it('empty alias returns matched:false', () => {
    const r1 = resolveEntity('');
    const r2 = resolveEntity('   ');
    const r3 = resolveEntity(null);
    assert.strictEqual(r1.matched, false);
    assert.strictEqual(r1.reason, 'empty_alias');
    assert.strictEqual(r2.matched, false);
    assert.strictEqual(r3.matched, false);
  });
});

describe('Entity Resolution - Paris vs Paris Hilton (no collapse)', () => {
  it('Paris is not in registry (no false collapse)', () => {
    const r = resolveEntity('Paris');
    assert.strictEqual(r.matched, false);
  });

  it('Paris Hilton is not in registry (no false collapse)', () => {
    const r = resolveEntity('Paris Hilton');
    assert.strictEqual(r.matched, false);
  });
});

describe('Entity Resolution - determinism', () => {
  it('repeated calls return identical output', () => {
    for (let i = 0; i < 10; i++) {
      const r1 = resolveEntity('B737', { domain: 'aviation' });
      const r2 = resolveEntity('AI', { domain: 'tech' });
      const r3 = resolveEntity('AI');
      assert.deepStrictEqual(r1, {
        matched: true,
        canonical: 'boeing_737',
        domain: 'aviation',
        confidence: 1,
        reason: 'exact_alias',
        aliases: ['b737', 'boeing 737', 'boeing-737'],
      });
      assert.deepStrictEqual(r2, {
        matched: true,
        canonical: 'artificial_intelligence',
        domain: 'tech',
        confidence: 1,
        reason: 'exact_alias',
        aliases: ['ai', 'artificial intelligence'],
      });
      assert.strictEqual(r3.matched, false);
      assert.strictEqual(r3.ambiguous, true);
      assert.ok(r3.candidates.includes('air_india'));
      assert.ok(r3.candidates.includes('artificial_intelligence'));
      assert.ok(r3.candidates.includes('adobe_illustrator'));
    }
  });

  it('output structure is stable (no extra/non-deterministic fields)', () => {
    const r = resolveEntity('B737', { domain: 'aviation' });
    const keys = Object.keys(r).sort();
    assert.deepStrictEqual(keys, ['aliases', 'canonical', 'confidence', 'domain', 'matched', 'reason']);
  });
});

describe('Entity Resolution - no runtime nondeterminism', () => {
  it('no Math.random, Date.now, or external state', () => {
    const r1 = resolveEntity('B737', { domain: 'aviation' });
    const r2 = resolveEntity('B737', { domain: 'aviation' });
    assert.deepStrictEqual(r1, r2);
  });

  it('concurrent calls are independent', () => {
    const promises = [];
    for (let i = 0; i < 20; i++) {
      promises.push(Promise.resolve().then(() => resolveEntity('AI', { domain: 'tech' })));
    }
    return Promise.all(promises).then((results) => {
      for (const r of results) {
        assert.strictEqual(r.canonical, 'artificial_intelligence');
        assert.strictEqual(r.domain, 'tech');
      }
    });
  });
});