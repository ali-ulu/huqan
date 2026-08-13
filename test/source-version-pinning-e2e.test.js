'use strict';

/**
 * End-to-end falsification for one claim: a receipt names a version of the
 * source, not just a location, so a source that moved cannot be mistaken for the
 * source that was read.
 *
 * The content hash added earlier makes drift *detectable* once you have both the
 * old record and the current bytes. It does not fix the other half: if the
 * recorded `sourceRef` points at a moving target -- a branch name, a bare URL --
 * then re-resolving it hands you today's content, and the comparison you make is
 * against the wrong thing. A verifier following the receipt goes to `main` and
 * reads whatever `main` says now.
 *
 * These cases exercise the adapters against a source that changes underneath
 * them, and assert the recorded reference still resolves to what was read.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

const githubAdapter = require('../adapters/github-adapter');
const { contentHash } = require('../lib/content-hash');

const COMMIT_A = 'a'.repeat(40);
const COMMIT_B = 'b'.repeat(40);

/**
 * A GitHub whose branch moves.
 *
 * `main` points at COMMIT_A carrying "before", then at COMMIT_B carrying
 * "after". Content is addressed by commit-ish, exactly as raw.githubusercontent
 * does, so a request pinned to COMMIT_A keeps returning "before" after the
 * branch has moved on -- which is the property under test.
 */
function movingRepo() {
  const state = { head: COMMIT_A };
  const byCommit = {
    [COMMIT_A]: '# Before\n\nThe original claim.\n',
    [COMMIT_B]: '# After\n\nA different claim.\n',
  };
  const requested = [];

  function response({ ok = true, status = 200, json = null, text = '' }) {
    return {
      ok,
      status,
      json: async () => json,
      text: async () => text,
      headers: { get: () => '' },
    };
  }

  const fetchImpl = async (url) => {
    requested.push(url);

    // Branch -> commit resolution.
    const commitMatch = url.match(/\/repos\/[^/]+\/[^/]+\/commits\/([^/?]+)$/);
    if (commitMatch) {
      const ref = decodeURIComponent(commitMatch[1]);
      const sha = ref === 'main' ? state.head : ref;
      if (!byCommit[sha]) return response({ ok: false, status: 404, json: {} });
      return response({ json: { sha } });
    }

    if (url.includes('/git/trees/')) {
      return response({ json: { tree: [{ type: 'blob', path: 'README.md' }] } });
    }

    // raw.githubusercontent.com/<owner>/<repo>/<commit-ish>/<path>
    const rawMatch = url.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([^/]+)\//);
    if (rawMatch) {
      const ref = decodeURIComponent(rawMatch[1]);
      const sha = ref === 'main' ? state.head : ref;
      const body = byCommit[sha];
      if (body === undefined) return response({ ok: false, status: 404, text: '' });
      return response({ text: body });
    }

    return response({ ok: false, status: 404, text: '' });
  };

  return {
    fetchImpl,
    requested,
    contentAt: (sha) => byCommit[sha],
    moveBranchTo: (sha) => { state.head = sha; },
  };
}

/** Captures what an adapter hands to learn(). */
function captureLearn() {
  const calls = [];
  const kernel = {
    learn(text, opts) {
      calls.push({ text, opts });
      return { data: { learned: 1 }, receipt: { receiptId: 'stub' } };
    },
  };
  kernel.learnAsync = async (text, opts) => kernel.learn(text, opts);
  return { kernel, calls };
}

test.describe('a GitHub ingest pins the commit, not the branch', () => {
  test('sourceRef carries a commit SHA', async () => {
    const repo = movingRepo();
    const { kernel, calls } = captureLearn();

    await githubAdapter.fetchAndLearn('https://github.com/o/r', kernel, {
      branch: 'main', fetchImpl: repo.fetchImpl,
    });

    assert.equal(calls.length, 1);
    const { sourceRef } = calls[0].opts.provenance;
    assert.ok(sourceRef.includes(COMMIT_A),
      `sourceRef does not name the commit that was read: ${sourceRef}`);
    assert.ok(!/\/blob\/main\//.test(sourceRef),
      `sourceRef still points at a branch, which moves: ${sourceRef}`);
  });

  test('after the branch moves, the recorded ref still names the old content', async () => {
    // The whole point. A verifier following the first receipt must land on what
    // was actually read, not on whatever the branch says today.
    const repo = movingRepo();

    const first = captureLearn();
    await githubAdapter.fetchAndLearn('https://github.com/o/r', first.kernel, {
      branch: 'main', fetchImpl: repo.fetchImpl,
    });
    const before = first.calls[0];

    repo.moveBranchTo(COMMIT_B);

    const second = captureLearn();
    await githubAdapter.fetchAndLearn('https://github.com/o/r', second.kernel, {
      branch: 'main', fetchImpl: repo.fetchImpl,
    });
    const after = second.calls[0];

    // Two ingests of "the same place" are now distinguishable.
    assert.notEqual(before.opts.provenance.sourceRef, after.opts.provenance.sourceRef,
      'the branch moved but both ingests recorded the same sourceRef');
    assert.notEqual(before.text, after.text, 'the fixture did not actually change');

    // The first record still describes the first content.
    assert.equal(before.opts.provenance.contentHash, contentHash(repo.contentAt(COMMIT_A)));
    assert.ok(before.opts.provenance.sourceRef.includes(COMMIT_A));

    // And the second content is not accepted under the first reference.
    assert.notEqual(before.opts.provenance.contentHash, contentHash(repo.contentAt(COMMIT_B)),
      'the moved content hashes the same as the original; this case proves nothing');
  });

  test('the pinned ref is what the adapter actually fetched, not a label', async () => {
    // A SHA written into sourceRef while the bytes were fetched from the branch
    // would pass the two cases above and still be wrong: the record would name a
    // commit it never read. This checks the raw request carried the SHA.
    const repo = movingRepo();
    const { kernel } = captureLearn();

    await githubAdapter.fetchAndLearn('https://github.com/o/r', kernel, {
      branch: 'main', fetchImpl: repo.fetchImpl,
    });

    const rawRequests = repo.requested.filter((u) => u.includes('raw.githubusercontent.com'));
    assert.ok(rawRequests.length > 0, 'no raw content request was made');
    for (const url of rawRequests) {
      assert.ok(url.includes(COMMIT_A),
        `content was fetched from a moving ref rather than the pinned commit: ${url}`);
      assert.ok(!/\/o\/r\/main\//.test(url),
        `content was fetched from the branch: ${url}`);
    }
  });

  test('an unresolvable branch fails instead of silently reading a default', async () => {
    const repo = movingRepo();
    const { kernel } = captureLearn();

    await assert.rejects(
      () => githubAdapter.fetchAndLearn('https://github.com/o/r', kernel, {
        branch: 'no-such-branch', fetchImpl: repo.fetchImpl,
      }),
      /resolve|not found|404/i,
    );
  });
});

test.describe('an HTTP ingest records the version identifier the server offered', () => {
  const httpAdapter = require('../adapters/http-adapter');

  /** Minimal stand-in for the adapter's own fetch, which is not exercised here. */
  function stubbedEntries(etag, body, lastModified = '') {
    const entry = {
      entryKey: 'root',
      filePath: 'https://example.org/doc',
      content: body,
      sourceRef: 'https://example.org/doc#root',
    };
    if (etag) entry.etag = etag;
    if (lastModified) entry.lastModified = lastModified;
    return { entries: [entry], errors: [] };
  }

  test('an ETag on the response reaches the provenance', async () => {
    const { kernel, calls } = captureLearn();
    await httpAdapter.learnEntries(stubbedEntries('"v1-etag"', 'body one'), kernel, {});

    assert.equal(calls.length, 1);
    const { provenance } = calls[0].opts;
    assert.equal(provenance.sourceVersion, '"v1-etag"',
      'the ETag the server sent was not recorded');
    assert.equal(provenance.sourceVersionKind, 'etag');
  });

  test('a changed ETag is visible even when the URL is identical', async () => {
    const first = captureLearn();
    await httpAdapter.learnEntries(stubbedEntries('"v1-etag"', 'body one'), first.kernel, {});

    const second = captureLearn();
    await httpAdapter.learnEntries(stubbedEntries('"v2-etag"', 'body two'), second.kernel, {});

    assert.equal(
      first.calls[0].opts.provenance.sourceRef,
      second.calls[0].opts.provenance.sourceRef,
      'the premise has changed: sourceRef already distinguishes these',
    );
    assert.notEqual(
      first.calls[0].opts.provenance.sourceVersion,
      second.calls[0].opts.provenance.sourceVersion,
    );
  });

  test('Last-Modified is used when there is no ETag, and labelled as the weaker signal', async () => {
    const { kernel, calls } = captureLearn();
    await httpAdapter.learnEntries(
      stubbedEntries('', 'body', 'Mon, 01 Jan 2024 00:00:00 GMT'), kernel, {},
    );

    const { provenance } = calls[0].opts;
    assert.equal(provenance.sourceVersion, 'Mon, 01 Jan 2024 00:00:00 GMT');
    assert.equal(provenance.sourceVersionKind, 'last_modified',
      'a Last-Modified must not be recorded as if it were an ETag');
  });

  test('no validator at all means no sourceVersion field, not an empty one', async () => {
    // A server that offers nothing must not produce a record that looks pinned.
    // Absent is the honest value.
    const { kernel, calls } = captureLearn();
    await httpAdapter.learnEntries(stubbedEntries('', 'body'), kernel, {});

    const { provenance } = calls[0].opts;
    assert.ok(!provenance.sourceVersion,
      `expected no sourceVersion, got ${JSON.stringify(provenance.sourceVersion)}`);
    assert.ok(provenance.contentHash,
      'with no server validator the content hash is the only version signal, and it is missing');
  });
});

// ---------------------------------------------------------------------------
// The cases above assert what the adapters hand to learn(). buildProvenance
// rebuilds provenance from an explicit field list, so a field an adapter sets
// can be dropped before anything stores it -- which is exactly what happened to
// contentHash. Asserting only the argument would look green while the version
// identifier never survived.
// ---------------------------------------------------------------------------

test.describe('the version identifier survives into the stored provenance', () => {
  const { buildProvenance } = require('../lib/provenance-ingest');

  test('buildProvenance carries sourceVersion and its kind through normalisation', () => {
    const built = buildProvenance({
      provenanceId: 'p',
      sourceRef: `https://github.com/o/r/blob/${COMMIT_A}/README.md`,
      sourceType: 'github',
      sourceSubType: 'blob',
      sourceVersion: COMMIT_A,
      sourceVersionKind: 'commit_sha',
    }, {});
    const provenance = built.provenance || built;

    assert.equal(provenance.sourceVersion, COMMIT_A,
      'sourceVersion did not survive buildProvenance; the adapters record a value nothing stores');
    assert.equal(provenance.sourceVersionKind, 'commit_sha');
  });

  test('a provenance without a version does not grow an empty one', () => {
    const built = buildProvenance({
      provenanceId: 'p', sourceRef: 'file:/x:y', sourceType: 'document',
    }, {});
    const provenance = built.provenance || built;
    assert.ok(!provenance.sourceVersion,
      `expected no sourceVersion, got ${JSON.stringify(provenance.sourceVersion)}`);
    assert.ok(!provenance.sourceVersionKind);
  });

  test('a GitHub ingest reaches storage with its commit intact', async () => {
    const repo = movingRepo();
    const { kernel, calls } = captureLearn();
    await githubAdapter.fetchAndLearn('https://github.com/o/r', kernel, {
      branch: 'main', fetchImpl: repo.fetchImpl,
    });

    const { opts } = calls[0];
    const built = buildProvenance(opts.provenance, {
      sourceType: opts.sourceType, sourceSubType: opts.sourceSubType, sourceRef: opts.sourceRef,
    });
    const provenance = built.provenance || built;

    assert.equal(provenance.sourceVersion, COMMIT_A);
    assert.equal(provenance.sourceVersionKind, 'commit_sha');
    assert.ok(provenance.sourceRef.includes(COMMIT_A));
    assert.equal(provenance.contentHash, contentHash(repo.contentAt(COMMIT_A)));
  });
});
