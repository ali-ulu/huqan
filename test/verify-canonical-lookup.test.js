const { describe, it, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Kernel = require('../kernel');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'axiom-verify-canonical-lookup-'));

after(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

function makeKernel(name) {
  const kernel = new Kernel({
    noLoad: true,
    useSQLite: false,
    memoryPath: path.join(tempDir, `${name}.json`),
  });

  kernel._autoMaintain = () => {};
  kernel.maintenanceEvery = Number.MAX_SAFE_INTEGER;
  kernel._learnCount = 0;
  return kernel;
}

function unwrap(result) {
  if (result && typeof result === 'object' && result.data && typeof result.data === 'object') {
    return result.data;
  }
  return result;
}

function withMutedConsole(fn) {
  const originalLog = console.log;
  const originalInfo = console.info;
  console.log = () => {};
  console.info = () => {};
  try {
    return fn();
  } finally {
    console.log = originalLog;
    console.info = originalInfo;
  }
}

function seedCanonicalEvidence(kernel) {
  withMutedConsole(() => {
    kernel.learn('boeing_737 güvenlidir', { workspaceId: 'default' });
    kernel.learn('air_india güvenlidir', { workspaceId: 'default' });
    kernel.learn('artificial_intelligence güçlüdür', { workspaceId: 'default' });
    kernel.learn('adobe_illustrator kullanılır', { workspaceId: 'default' });
  });
}

describe('PR-ER2B - canonical lookup fallback in verify', () => {
  it('falls back from B737 to canonical evidence when aviation evidence exists', () => {
    const kernel = makeKernel('b737-fallback');
    seedCanonicalEvidence(kernel);

    const before = {
      nodes: kernel.graph.nodeCount('default'),
      edges: kernel.graph.edgeCount('default'),
    };

    const raw = kernel.verify('B737 güvenlidir', { workspaceId: 'default', domain: 'aviation' });
    const result = unwrap(raw);
    const er = raw.meta.entityResolution.subject;
    const after = {
      nodes: kernel.graph.nodeCount('default'),
      edges: kernel.graph.edgeCount('default'),
    };

    assert.strictEqual(result.status, 'dogrulandi');
    assert.strictEqual(er.original, 'B737');
    assert.strictEqual(er.canonical, 'boeing_737');
    assert.strictEqual(er.domain, 'aviation');
    assert.strictEqual(er.matched, true);
    assert.strictEqual(er.usedForLookup, true);
    assert.strictEqual(before.nodes, after.nodes);
    assert.strictEqual(before.edges, after.edges);
  });

  it('treats Boeing-737 and Boeing 737 as the same canonical lookup', () => {
    const kernel = makeKernel('boeing-737-equivalence');
    seedCanonicalEvidence(kernel);

    const a = kernel.verify('Boeing-737 güvenlidir', { workspaceId: 'default', domain: 'aviation' });
    const b = kernel.verify('Boeing 737 güvenlidir', { workspaceId: 'default', domain: 'aviation' });

    assert.strictEqual(unwrap(a).status, 'dogrulandi');
    assert.strictEqual(unwrap(b).status, 'dogrulandi');
    assert.strictEqual(a.meta.entityResolution.subject.canonical, 'boeing_737');
    assert.strictEqual(b.meta.entityResolution.subject.canonical, 'boeing_737');
    assert.strictEqual(a.meta.entityResolution.subject.usedForLookup, true);
    assert.strictEqual(b.meta.entityResolution.subject.usedForLookup, true);
  });

  it('does not verify solely because an alias resolved when canonical evidence is missing', () => {
    const kernel = makeKernel('alias-without-canonical-evidence');

    const raw = kernel.verify('B737 güvenlidir', { workspaceId: 'default', domain: 'aviation' });
    const result = unwrap(raw);
    const er = raw.meta.entityResolution.subject;

    assert.strictEqual(result.status, 'bilinmiyor');
    assert.strictEqual(er.original, 'B737');
    assert.strictEqual(er.canonical, 'boeing_737');
    assert.strictEqual(er.matched, true);
    assert.strictEqual(er.usedForLookup, false);
  });

  it('keeps ambiguous AI unchanged without a domain', () => {
    const kernel = makeKernel('ambiguous-ai');
    seedCanonicalEvidence(kernel);

    const raw = kernel.verify('AI güvenlidir', { workspaceId: 'default' });
    const result = unwrap(raw);
    const er = raw.meta.entityResolution.subject;

    assert.strictEqual(result.status, 'bilinmiyor');
    assert.strictEqual(er.original, 'AI');
    assert.strictEqual(er.ambiguous, true);
    assert.strictEqual(er.usedForLookup, false);
  });

  it('resolves AI only within an explicit domain when canonical evidence exists', () => {
    const kernel = makeKernel('domain-scoped-ai');
    seedCanonicalEvidence(kernel);

    const aviation = kernel.verify('AI güvenlidir', { workspaceId: 'default', domain: 'aviation' });
    const tech = kernel.verify('AI güçlüdür', { workspaceId: 'default', domain: 'tech' });
    const design = kernel.verify('AI kullanılır', { workspaceId: 'default', domain: 'design' });

    assert.strictEqual(unwrap(aviation).status, 'dogrulandi');
    assert.strictEqual(unwrap(tech).status, 'dogrulandi');
    assert.strictEqual(unwrap(design).status, 'dogrulandi');
    assert.strictEqual(aviation.meta.entityResolution.subject.canonical, 'air_india');
    assert.strictEqual(tech.meta.entityResolution.subject.canonical, 'artificial_intelligence');
    assert.strictEqual(design.meta.entityResolution.subject.canonical, 'adobe_illustrator');
    assert.strictEqual(aviation.meta.entityResolution.subject.usedForLookup, true);
    assert.strictEqual(tech.meta.entityResolution.subject.usedForLookup, true);
    assert.strictEqual(design.meta.entityResolution.subject.usedForLookup, true);
  });

  it('keeps unknown aliases unchanged', () => {
    const kernel = makeKernel('unknown-alias');
    seedCanonicalEvidence(kernel);

    const raw = kernel.verify('XYZ999 güvenlidir', { workspaceId: 'default', domain: 'aviation' });
    const result = unwrap(raw);
    const er = raw.meta.entityResolution.subject;

    assert.strictEqual(result.status, 'bilinmiyor');
    assert.strictEqual(er.original, 'XYZ999');
    assert.strictEqual(er.matched, false);
    assert.strictEqual(er.reason, 'unknown_alias_in_domain');
    assert.strictEqual(er.usedForLookup, false);
  });

  it('does not mutate graph during verify', () => {
    const kernel = makeKernel('read-only');
    seedCanonicalEvidence(kernel);

    const before = {
      nodes: kernel.graph.nodeCount('default'),
      edges: kernel.graph.edgeCount('default'),
    };

    const raw = kernel.verify('B737 güvenlidir', { workspaceId: 'default', domain: 'aviation' });
    const result = unwrap(raw);
    const after = {
      nodes: kernel.graph.nodeCount('default'),
      edges: kernel.graph.edgeCount('default'),
    };

    assert.strictEqual(result.status, 'dogrulandi');
    assert.deepStrictEqual(after, before);
  });

  it('keeps exact canonical verify behavior stable', () => {
    const kernel = makeKernel('exact-canonical');
    seedCanonicalEvidence(kernel);

    const raw = kernel.verify('boeing_737 güvenlidir', { workspaceId: 'default' });
    const result = unwrap(raw);
    const er = raw.meta.entityResolution.subject;

    assert.strictEqual(result.status, 'dogrulandi');
    assert.strictEqual(er.original, 'boeing_737');
    assert.strictEqual(er.matched, false);
    assert.strictEqual(er.usedForLookup, false);
  });
});
