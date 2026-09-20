'use strict';

/**
 * T1 property: path containment (#2634).
 *
 * Every generated path either fails closed (throws) or resolves to a
 * location strictly within the workspace root. Covers `../` traversal,
 * percent-encoded traversal, unicode, absolute paths, Windows drive
 * spellings and mixed separators.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const fc = require('fast-check');

const {
  isPathWithinRoot,
  resolvePathWithinRoot,
} = require('../../lib/path-safety');

const NUM_RUNS = 1000;

const trickySegment = fc.constantFrom(
  '..',
  '.',
  '',
  'a',
  'seg',
  'foo bar',
  '%2e%2e',
  '%2f',
  '..%2f',
  '%c0%ae',
  '\u2024\u2024',
  '\uFF0E\uFF0E',
  'a..b',
  '...',
  'C:',
  'C:\\Windows',
  '\\\\server\\share',
);

const segmentList = fc.array(trickySegment, { minLength: 1, maxLength: 6 });

function buildCandidate(root, segments, suffix) {
  const pick = suffix % 4;
  const joined = segments.join('/');
  if (pick === 0) return path.join(root, joined);
  if (pick === 1) return `${root}/${joined}`.replace(/\//g, '\\');
  if (pick === 2) return `/${joined}`;
  return joined;
}

describe('property: path containment stays within workspace', () => {
  it('resolvePathWithinRoot fails closed or stays inside root', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-prop-path-'));
    try {
      fc.assert(
        fc.property(segmentList, fc.integer({ min: 0, max: 100000 }), (segments, suffix) => {
          const candidate = buildCandidate(root, segments, suffix);
          let resolved = null;
          let threw = null;
          try {
            resolved = resolvePathWithinRoot(root, candidate, { allowMissing: true });
          } catch (err) {
            threw = err;
          }
          if (threw) {
            assert.ok(threw instanceof Error, 'failure must be an Error (fail-closed)');
          } else {
            assert.ok(
              isPathWithinRoot(root, resolved),
              `resolved path escapes root: ${resolved}`,
            );
          }
        }),
        { numRuns: NUM_RUNS },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('isPathWithinRoot never reports an escaping path as inside', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'huqan-prop-path2-'));
    try {
      fc.assert(
        fc.property(fc.string({ maxLength: 120 }), (raw) => {
          const candidate = path.join(root, raw);
          const inside = isPathWithinRoot(root, candidate);
          if (!inside) {
            assert.throws(
              () => resolvePathWithinRoot(root, candidate, { allowMissing: true }),
              /.+/,
              `escaping path must throw: ${candidate}`,
            );
          }
        }),
        { numRuns: NUM_RUNS },
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
