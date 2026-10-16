'use strict';

/**
 * T1 property: workspace isolation (#2634).
 *
 * Operations in one workspace never affect another: every stored record is
 * listed only under its own workspace, counts match exactly, and content
 * written under workspace A is never visible from workspace B.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const MemoryStore = require('../../lib/memory-store');

const NUM_RUNS = 1000;
const wsIdArb = fc.stringMatching(/^[a-z0-9][a-z0-9-]{2,15}$/);
// NOTE: contents are unique within a run on purpose. generateMemoryId()
// (lib/memory-store-utils.js) hashes content+workspace+ms-timestamp, so two
// same-ms stores of byte-identical content in one workspace collide to one
// record. That same-ms duplicate edge is a T5 (recovery/no-data-loss)
// follow-up, not an isolation question — isolation is what this file owns.
const contentArb = fc.string({ minLength: 1, maxLength: 200 });

describe('property: workspace isolation', () => {
  it('records stored in one workspace are invisible from another', () => {
    fc.assert(
      fc.property(wsIdArb, wsIdArb, fc.uniqueArray(contentArb, { minLength: 1, maxLength: 4 }), (rawA, rawB, contents) => {
        fc.pre(!rawA.includes('..') && !rawB.includes('..'));
        const wsA = `t1-a-${rawA}`;
        const wsB = `t1-b-${rawB}`;
        fc.pre(wsA !== wsB);
        const store = new MemoryStore({ memoryStorePath: ':memory:' });
        try {
          let expectedA = 0;
          let expectedB = 0;
          for (const content of contents) {
            const a = store.store({
              workspaceId: wsA,
              kind: 'note',
              content: `A:${content}`,
              sourceRef: 'prop-test',
              provenanceId: 'prop',
            });
            assert.ok(a.ok, 'store into wsA must succeed');
            expectedA += 1;
            const b = store.store({
              workspaceId: wsB,
              kind: 'note',
              content: `B:${content}`,
              sourceRef: 'prop-test',
              provenanceId: 'prop',
            });
            assert.ok(b.ok, 'store into wsB must succeed');
            expectedB += 1;
          }
          const listA = store.list({ workspaceId: wsA }).memories;
          const listB = store.list({ workspaceId: wsB }).memories;
          assert.equal(listA.length, expectedA, 'wsA count must match exactly');
          assert.equal(listB.length, expectedB, 'wsB count must match exactly');
          for (const m of listA) {
            assert.equal(m.workspaceId, wsA, 'wsA listing must not leak wsB records');
            assert.ok(String(m.content).startsWith('A:'), 'wsA content prefix intact');
          }
          for (const m of listB) {
            assert.equal(m.workspaceId, wsB, 'wsB listing must not leak wsA records');
            assert.ok(String(m.content).startsWith('B:'), 'wsB content prefix intact');
          }
          const idsA = new Set(listA.map((m) => m.memoryId));
          for (const m of listB) {
            assert.ok(!idsA.has(m.memoryId), 'memory ids must not cross workspaces');
          }
        } finally {
          store.close();
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
