'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const Kernel = require('../kernel');
const KernelV2 = require('../kernel.v2');
const { buildNegationConflict, collectTypeTargetsAsFacts } = require('../lib/kernel-v2-type-negation');

const ROOT = path.join(__dirname, '..');
const PROMOTED = [
  'normalizePredicateToken',
  'isTypeRelation',
  'collectFactTargets',
  'buildDirectFactEvidence',
  'buildDirectTypeEvidence',
];

function withV2(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-2357-'));
  try {
    const kernel = new Kernel({ noLoad: true, loadPlugins: false, useSQLite: false, memoryPath: path.join(dir, 'memory.json'), lang: 'tr' });
    kernel._autoMaintain = () => {};
    kernel.maintenanceEvery = Number.MAX_SAFE_INTEGER;
    run(new KernelV2({ kernel }), kernel);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// A stand-in that offers only the documented public surface to its caller.
// Any reach for a `_`-prefixed member from outside throws instead of silently
// resolving to undefined. Methods are bound to the real instance, so a public
// method's own internal helpers stay private to KernelV2 and are not flagged.
function publicOnly(v2) {
  return new Proxy(v2, {
    get(target, prop) {
      if (typeof prop === 'string' && prop.startsWith('_')) throw new Error(`private KernelV2 surface used: ${prop}`);
      const value = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

describe('KernelV2 negation helpers are public (#2357)', () => {
  it('the five helpers are public and their private names are gone', () => {
    for (const name of PROMOTED) {
      assert.equal(typeof KernelV2.prototype[name], 'function', `${name} must be public`);
      assert.equal(KernelV2.prototype[`_${name}`], undefined, `_${name} must be gone`);
    }
  });

  it('the negation module reaches KernelV2 only through the public surface', () => {
    withV2((v2, kernel) => {
      kernel.graph.addNode('ali', 'ali');
      kernel.graph.addNode('doktor', 'doktor');
      kernel.graph.addNode('hekim', 'hekim');
      kernel.graph.addEdge('ali', 'doktor', 'yapabilir', { confidence: 0.9, weight: 0.85 });
      kernel.graph.addEdge('ali', 'hekim', 'tür', { confidence: 0.9, weight: 0.9 });
      const guarded = publicOnly(v2);

      const fact = buildNegationConflict(guarded, { subject: 'ali', isNegated: true }, 'doktor', 'doktor');
      assert.equal(fact.contradictionReason, 'negated_statement_conflicts_with_known_fact');
      assert.match(fact.evidence[0].text, /yapabilir/);

      const type = buildNegationConflict(guarded, { subject: 'ali', isNegated: true }, 'hekim', 'hekim');
      assert.match(type.evidence[0].text, /tür/);

      assert.deepEqual(collectTypeTargetsAsFacts(guarded, 'ali').map(f => f.rawTarget), ['hekim']);
    });
  });

  it('the negation module source names no private KernelV2 helper', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib', 'kernel-v2-type-negation.js'), 'utf8');
    for (const name of PROMOTED) {
      assert.doesNotMatch(source, new RegExp(`\\b_${name}\\b`), `lib/kernel-v2-type-negation.js must not name _${name}`);
    }
  });
});
