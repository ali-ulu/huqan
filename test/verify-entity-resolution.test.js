const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert');
const VerifyService = require('../lib/verify');
const { resolveEntity } = require('../lib/entity-resolution');

function createStubKernel() {
  return {
    _ok: (cmd, data, evidence, meta) => ({ ok: true, cmd, data, evidence, meta }),
    _parseNumericComparison: () => null,
    graph: {
      getNode: () => null,
      getEdges: () => [],
      getEdge: () => null,
    },
  };
}

function callVerifyResult(service, statement, opts, data, evidence, context) {
  return service._verifyResult(statement, opts, data, evidence, context);
}

function makeContext(overrides = {}) {
  return {
    workspaceId: 'default',
    subject: '',
    predicate: '',
    edges: [],
    decomposition: {
      originalClaim: 'B737 güvenlidir',
      compound: false,
      subclaims: [{ id: 'claim_1', claim: 'B737 güvenlidir', required: true, source: 'deterministic' }],
      warnings: [],
    },
    ...overrides,
  };
}

describe('PR-ER2A - Verify Read-only Entity Resolution Probe', () => {
  let service;

  beforeEach(() => {
    service = new VerifyService(createStubKernel());
  });

  describe('matched alias (aviation domain)', () => {
    it('B737 with aviation domain produces matched probe metadata without changing verdict', () => {
      const ctx = makeContext({ subject: 'B737' });
      const result = callVerifyResult(
        service,
        'B737 güvenlidir',
        { domain: 'aviation' },
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      const er = result.meta.entityResolution.subject;
      assert.strictEqual(er.original, 'B737');
      assert.strictEqual(er.matched, true);
      assert.strictEqual(er.canonical, 'boeing_737');
      assert.strictEqual(er.domain, 'aviation');
      assert.strictEqual(er.reason, 'exact_alias');
      assert.ok(Array.isArray(er.aliases));
      assert.ok(er.aliases.includes('b737'));
      assert.ok(er.aliases.includes('boeing 737'));
      assert.strictEqual(result.data.status, 'bilinmiyor');
      assert.strictEqual(result.data.confidence, 0);
    });

    it('Boeing 737 with aviation domain resolves to same canonical', () => {
      const ctx = makeContext({ subject: 'Boeing 737' });
      const result = callVerifyResult(
        service,
        'Boeing 737 güvenlidir',
        { domain: 'aviation' },
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      const er = result.meta.entityResolution.subject;
      assert.strictEqual(er.original, 'Boeing 737');
      assert.strictEqual(er.matched, true);
      assert.strictEqual(er.canonical, 'boeing_737');
      assert.strictEqual(er.domain, 'aviation');
    });

    it('Boeing-737 with aviation domain resolves to same canonical', () => {
      const ctx = makeContext({ subject: 'Boeing-737' });
      const result = callVerifyResult(
        service,
        'Boeing-737 güvenlidir',
        { domain: 'aviation' },
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      const er = result.meta.entityResolution.subject;
      assert.strictEqual(er.matched, true);
      assert.strictEqual(er.canonical, 'boeing_737');
    });
  });

  describe('ambiguous alias (no domain)', () => {
    it('AI without domain returns ambiguous metadata and does not change verdict', () => {
      const ctx = makeContext({ subject: 'AI' });
      const result = callVerifyResult(
        service,
        'AI tehlikelidir',
        {},
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      const er = result.meta.entityResolution.subject;
      assert.strictEqual(er.original, 'AI');
      assert.strictEqual(er.matched, false);
      assert.strictEqual(er.ambiguous, true);
      assert.ok(Array.isArray(er.candidates));
      assert.ok(er.candidates.includes('air_india'));
      assert.ok(er.candidates.includes('artificial_intelligence'));
      assert.ok(er.candidates.includes('adobe_illustrator'));
      assert.strictEqual(er.reason, 'ambiguous_alias_requires_domain');
      assert.strictEqual(result.data.status, 'bilinmiyor');
      assert.strictEqual(result.data.confidence, 0);
    });
  });

  describe('domain-scoped resolution', () => {
    it('AI with aviation domain resolves to air_india', () => {
      const ctx = makeContext({ subject: 'AI' });
      const result = callVerifyResult(
        service,
        'AI güvenlidir',
        { domain: 'aviation' },
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      const er = result.meta.entityResolution.subject;
      assert.strictEqual(er.matched, true);
      assert.strictEqual(er.canonical, 'air_india');
      assert.strictEqual(er.domain, 'aviation');
    });

    it('AI with tech domain resolves to artificial_intelligence', () => {
      const ctx = makeContext({ subject: 'AI' });
      const result = callVerifyResult(
        service,
        'AI güçlüdür',
        { domain: 'tech' },
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      const er = result.meta.entityResolution.subject;
      assert.strictEqual(er.matched, true);
      assert.strictEqual(er.canonical, 'artificial_intelligence');
      assert.strictEqual(er.domain, 'tech');
    });

    it('AI with design domain resolves to adobe_illustrator', () => {
      const ctx = makeContext({ subject: 'AI' });
      const result = callVerifyResult(
        service,
        'AI kullanılır',
        { domain: 'design' },
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      const er = result.meta.entityResolution.subject;
      assert.strictEqual(er.matched, true);
      assert.strictEqual(er.canonical, 'adobe_illustrator');
      assert.strictEqual(er.domain, 'design');
    });
  });

  describe('unknown alias', () => {
    it('unknown alias produces matched:false without changing verdict', () => {
      const ctx = makeContext({ subject: 'XYZ999' });
      const result = callVerifyResult(
        service,
        'XYZ999 tehlikelidir',
        { domain: 'aviation' },
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      const er = result.meta.entityResolution.subject;
      assert.strictEqual(er.original, 'XYZ999');
      assert.strictEqual(er.matched, false);
      assert.strictEqual(er.ambiguous, undefined);
      assert.strictEqual(er.reason, 'unknown_alias_in_domain');
      assert.strictEqual(result.data.status, 'bilinmiyor');
      assert.strictEqual(result.data.confidence, 0);
    });
  });

  describe('empty / missing subject', () => {
    it('empty subject produces empty_subject reason', () => {
      const ctx = makeContext({ subject: '' });
      const result = callVerifyResult(
        service,
        'güvenlidir',
        { domain: 'aviation' },
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      const er = result.meta.entityResolution.subject;
      assert.strictEqual(er.original, '');
      assert.strictEqual(er.matched, false);
      assert.strictEqual(er.reason, 'empty_subject');
    });

    it('whitespace-only subject treated as empty', () => {
      const ctx = makeContext({ subject: '   ' });
      const result = callVerifyResult(
        service,
        'güvenlidir',
        { domain: 'aviation' },
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      const er = result.meta.entityResolution.subject;
      assert.strictEqual(er.original, '');
      assert.strictEqual(er.matched, false);
      assert.strictEqual(er.reason, 'empty_subject');
    });

    it('missing subject field treated as empty', () => {
      const ctx = makeContext({ subject: undefined });
      const result = callVerifyResult(
        service,
        'güvenlidir',
        { domain: 'aviation' },
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      const er = result.meta.entityResolution.subject;
      assert.strictEqual(er.matched, false);
      assert.strictEqual(er.reason, 'empty_subject');
    });
  });

  describe('backward compatibility - probe is meta-only, verdict recomputed from semantic trust', () => {
    it('matched alias: probe attached, data shape preserved (status string, confidence number)', () => {
      const ctx = makeContext({ subject: 'B737' });
      const result = callVerifyResult(
        service,
        'B737 güvenlidir',
        { domain: 'aviation' },
        { status: 'dogrulandi', confidence: 0.85 },
        [],
        ctx
      );
      assert.strictEqual(typeof result.data.status, 'string');
      assert.ok(result.data.status.length > 0);
      assert.strictEqual(typeof result.data.confidence, 'number');
      assert.strictEqual(result.meta.entityResolution.subject.canonical, 'boeing_737');
    });

    it('ambiguous alias: probe attached, data shape preserved', () => {
      const ctx = makeContext({ subject: 'AI' });
      const result = callVerifyResult(
        service,
        'AI tehlikelidir',
        {},
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      assert.strictEqual(typeof result.data.status, 'string');
      assert.strictEqual(typeof result.data.confidence, 'number');
      assert.strictEqual(result.meta.entityResolution.subject.ambiguous, true);
    });

    it('unknown alias: probe attached, data shape preserved', () => {
      const ctx = makeContext({ subject: 'XYZ999' });
      const result = callVerifyResult(
        service,
        'XYZ999 çelişiyor',
        {},
        { status: 'celiski', confidence: 0.7 },
        [],
        ctx
      );
      assert.strictEqual(typeof result.data.status, 'string');
      assert.strictEqual(typeof result.data.confidence, 'number');
      assert.strictEqual(result.meta.entityResolution.subject.matched, false);
    });

    it('probe is decoupled: identical verdict inputs (sans subject) produce identical verdicts regardless of subject resolution', () => {
      const ctxB = makeContext({ subject: 'B737' });
      const ctxX = makeContext({ subject: 'XYZ999' });
      const input = (ctx) => callVerifyResult(
        service,
        'test',
        { domain: 'aviation' },
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      const a = input(ctxB);
      const b = input(ctxX);
      assert.strictEqual(a.data.status, b.data.status);
      assert.strictEqual(a.data.confidence, b.data.confidence);
      assert.notStrictEqual(a.meta.entityResolution.subject.matched, b.meta.entityResolution.subject.matched);
    });
  });

  describe('original literal label preservation', () => {
    it('B737 original is preserved exactly in metadata', () => {
      const ctx = makeContext({ subject: 'B737' });
      const result = callVerifyResult(
        service,
        'B737 güvenlidir',
        { domain: 'aviation' },
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      assert.strictEqual(result.meta.entityResolution.subject.original, 'B737');
    });

    it('preserves casing and whitespace in original', () => {
      const ctx = makeContext({ subject: '  Boeing  737  ' });
      const result = callVerifyResult(
        service,
        'Boeing 737 güvenlidir',
        { domain: 'aviation' },
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      assert.strictEqual(result.meta.entityResolution.subject.original, 'Boeing  737');
    });
  });

  describe('domain option propagation', () => {
    it('no opts.domain uses undefined domain (ambiguous candidates collected)', () => {
      const ctx = makeContext({ subject: 'AI' });
      const result = callVerifyResult(
        service,
        'AI tehlikelidir',
        {},
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      const er = result.meta.entityResolution.subject;
      assert.strictEqual(er.ambiguous, true);
    });

    it('empty string opts.domain is treated as no domain', () => {
      const ctx = makeContext({ subject: 'AI' });
      const result = callVerifyResult(
        service,
        'AI tehlikelidir',
        { domain: '' },
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      const er = result.meta.entityResolution.subject;
      assert.strictEqual(er.ambiguous, true);
    });
  });

  describe('probe determinism', () => {
    it('repeated calls return identical entityResolution for same input', () => {
      const ctx = makeContext({ subject: 'B737' });
      const a = callVerifyResult(
        service,
        'B737 güvenlidir',
        { domain: 'aviation' },
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      const b = callVerifyResult(
        service,
        'B737 güvenlidir',
        { domain: 'aviation' },
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      assert.deepStrictEqual(a.meta.entityResolution, b.meta.entityResolution);
    });
  });

  describe('read-only contract - no graph mutation', () => {
    it('entity-resolution module is pure and side-effect free', () => {
      const ctx = makeContext({ subject: 'B737' });
      const beforeRef = resolveEntity('B737', { domain: 'aviation' });
      const result = callVerifyResult(
        service,
        'B737 güvenlidir',
        { domain: 'aviation' },
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      const afterRef = resolveEntity('B737', { domain: 'aviation' });
      assert.deepStrictEqual(beforeRef, afterRef);
      assert.strictEqual(result.meta.entityResolution.subject.canonical, 'boeing_737');
    });

    it('probe does not call kernel.graph with write API (read-only stubs untouched)', () => {
      const writes = [];
      const trackingKernel = {
        ...createStubKernel(),
        graph: {
          getNode: () => null,
          getEdges: () => [],
          getEdge: () => null,
          addNode: (...args) => { writes.push(['addNode', ...args]); return null; },
          addEdge: (...args) => { writes.push(['addEdge', ...args]); return null; },
          removeNode: (...args) => { writes.push(['removeNode', ...args]); return null; },
        },
      };
      const trackedService = new VerifyService(trackingKernel);
      const ctx = makeContext({ subject: 'B737' });
      callVerifyResult(
        trackedService,
        'B737 güvenlidir',
        { domain: 'aviation' },
        { status: 'bilinmiyor', confidence: 0 },
        [],
        ctx
      );
      assert.deepStrictEqual(writes, []);
    });
  });
});
