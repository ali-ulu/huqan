'use strict';

/**
 * Falsification test for one claim: a trust receipt lets you check whether the
 * source it cites still says what it said at ingest.
 *
 * `sourceRef` is what a receipt offers a reader who wants to go look. For six of
 * the seven adapters it names a location and nothing else -- `file:/path/x.json:claim`,
 * `https://example.org/page#Heading`, `https://github.com/o/r/blob/main/README.md`.
 * All three keep resolving after the content behind them changes. Only
 * git-log-adapter pins, and only because a commit hash is what it had to hand.
 *
 * So the receipt can say "verified against this source" while nothing in it can
 * distinguish the source it saw from the source you are looking at now.
 *
 * The fix under test is a content hash recorded at ingest. What that buys is
 * stated narrowly on purpose, and asserted as narrowly at the bottom of this
 * file: it detects *drift* -- re-fetch, re-hash, compare -- and it does not make
 * the record tamper-evident, because the hash sits inside the record it
 * describes. That is the same boundary V5-C5A had to draw for receipt bundles.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const { contentHash, CONTENT_HASH_ALGORITHM } = require('../lib/content-hash');

const jsonAdapter = require('../adapters/json-adapter');
const yamlAdapter = require('../adapters/yaml-adapter');
const markdownAdapter = require('../adapters/markdown-adapter');

const tempDirs = [];

function makeTempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `huqan-pin-${label}-`));
  tempDirs.push(dir);
  return dir;
}

test.after(() => {
  for (const dir of tempDirs) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* best effort */ }
  }
});

/** Runs an adapter's ingestAndLearn against a stub kernel, returning the learn calls. */
function captureLearnCalls(run) {
  const calls = [];
  const kernel = {
    learn(text, opts) {
      calls.push({ text, opts });
      return { data: { learned: 1 }, receipt: { receiptId: 'stub' } };
    },
  };
  kernel.learnAsync = async (text, opts) => kernel.learn(text, opts);
  run(kernel);
  return calls;
}

// ---------------------------------------------------------------------------

test.describe('ingest records what the source said, not only where it was', () => {
  test('a file adapter records a content hash on its provenance', () => {
    const dir = makeTempDir('json');
    const file = path.join(dir, 'note.json');
    fs.writeFileSync(file, JSON.stringify({ claim: 'A bounded claim' }), 'utf8');

    const calls = captureLearnCalls((kernel) => {
      jsonAdapter.ingestAndLearn(file, kernel, { rootPath: dir, actor: 'pin-test' });
    });

    assert.equal(calls.length, 1);
    const { provenance } = calls[0].opts;
    assert.ok(provenance.contentHash,
      'provenance carries no contentHash, so nothing records what the file said at ingest');
    assert.equal(provenance.contentHashAlgorithm, CONTENT_HASH_ALGORITHM);
  });

  test('the recorded hash is the hash of the content that was learned', () => {
    // Present-and-well-formed is the easy half. This checks the value is
    // actually derived from the ingested bytes, so a constant or a hash of the
    // wrong thing fails here rather than looking correct forever.
    const dir = makeTempDir('value');
    const file = path.join(dir, 'note.json');
    fs.writeFileSync(file, JSON.stringify({ claim: 'A bounded claim' }), 'utf8');

    const calls = captureLearnCalls((kernel) => {
      jsonAdapter.ingestAndLearn(file, kernel, { rootPath: dir, actor: 'pin-test' });
    });

    const { text, opts } = calls[0];
    assert.equal(opts.provenance.contentHash, contentHash(text),
      'contentHash does not match a hash of the text that was learned');
    assert.equal(
      opts.provenance.contentHash,
      crypto.createHash('sha256').update(text, 'utf8').digest('hex'),
      'contentHash is not a plain sha256 of the learned text',
    );
  });

  test('changing one byte of the source changes the recorded hash', () => {
    // The property the whole thing exists for: two ingests of the same location
    // are distinguishable when the content behind it moved.
    const dir = makeTempDir('drift');
    const file = path.join(dir, 'note.json');

    fs.writeFileSync(file, JSON.stringify({ claim: 'Original text' }), 'utf8');
    const before = captureLearnCalls((kernel) => {
      jsonAdapter.ingestAndLearn(file, kernel, { rootPath: dir, actor: 'pin-test' });
    })[0].opts.provenance;

    fs.writeFileSync(file, JSON.stringify({ claim: 'Original texu' }), 'utf8');
    const after = captureLearnCalls((kernel) => {
      jsonAdapter.ingestAndLearn(file, kernel, { rootPath: dir, actor: 'pin-test' });
    })[0].opts.provenance;

    assert.equal(before.sourceRef, after.sourceRef,
      'the premise of this test has changed: sourceRef already distinguishes the two');
    assert.notEqual(before.contentHash, after.contentHash,
      'a one-byte change produced the same contentHash; drift is not detectable');
  });

  test('every content-bearing adapter records a hash, not just the one tested above', () => {
    const dir = makeTempDir('all');

    const cases = [
      {
        name: 'json',
        file: path.join(dir, 'a.json'),
        write: () => fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify({ claim: 'x' }), 'utf8'),
        run: (kernel) => jsonAdapter.ingestAndLearn(path.join(dir, 'a.json'), kernel, { rootPath: dir }),
      },
      {
        name: 'yaml',
        file: path.join(dir, 'b.yaml'),
        write: () => fs.writeFileSync(path.join(dir, 'b.yaml'), 'claim: a bounded claim\n', 'utf8'),
        run: (kernel) => yamlAdapter.ingestAndLearn(path.join(dir, 'b.yaml'), kernel, { rootPath: dir }),
      },
      {
        name: 'markdown',
        file: path.join(dir, 'c.md'),
        write: () => fs.writeFileSync(path.join(dir, 'c.md'), '# Heading\n\nA bounded claim.\n', 'utf8'),
        run: (kernel) => markdownAdapter.ingestAndLearn(path.join(dir, 'c.md'), kernel, { rootPath: dir }),
      },
    ];

    const missing = [];
    for (const item of cases) {
      item.write();
      const calls = captureLearnCalls(item.run);
      if (calls.length === 0) {
        missing.push(`${item.name}: adapter learned nothing, so this case measured nothing`);
        continue;
      }
      for (const call of calls) {
        const recorded = call.opts.provenance && call.opts.provenance.contentHash;
        if (recorded !== contentHash(call.text)) {
          missing.push(`${item.name}: contentHash ${recorded || '(absent)'} does not match the learned text`);
        }
      }
    }

    assert.deepStrictEqual(missing, []);
  });
});

// ---------------------------------------------------------------------------
// The cases above assert what the adapter hands to learn(). That is the easy
// half: provenance is normalised on the way in by buildProvenance, which
// rebuilds the object from an explicit field list, so a field an adapter sets
// can be dropped before anything stores it. Asserting the argument would have
// looked green while the hash never survived.
// ---------------------------------------------------------------------------

test.describe('the hash survives into the stored provenance', () => {
  const { buildProvenance } = require('../lib/provenance-ingest');

  test('buildProvenance carries contentHash through normalisation', () => {
    const hash = contentHash('A bounded claim');
    const built = buildProvenance({
      provenanceId: 'p',
      sourceRef: 'file:/x/note.json:claim',
      sourceType: 'document',
      sourceSubType: 'json',
      contentHash: hash,
      contentHashAlgorithm: CONTENT_HASH_ALGORITHM,
    }, {});
    const provenance = built.provenance || built;

    assert.equal(provenance.contentHash, hash,
      'contentHash did not survive buildProvenance; the adapters record a value nothing stores');
    assert.equal(provenance.contentHashAlgorithm, CONTENT_HASH_ALGORITHM);
  });

  test('a provenance without a hash does not grow empty hash fields', () => {
    // Absent must stay absent. An empty string would read as "hashed, and the
    // hash is nothing", which is worse than a missing field.
    const built = buildProvenance({
      provenanceId: 'p', sourceRef: 'file:/x:y', sourceType: 'document',
    }, {});
    const provenance = built.provenance || built;
    assert.ok(!('contentHash' in provenance) || provenance.contentHash === undefined,
      `contentHash should be absent, got ${JSON.stringify(provenance.contentHash)}`);
  });

  test('an adapter ingest reaches storage with its hash intact', () => {
    // End to end through the real normaliser rather than the stub kernel: this
    // is the assertion the four cases above could not make.
    const dir = makeTempDir('endtoend');
    const file = path.join(dir, 'note.json');
    fs.writeFileSync(file, JSON.stringify({ claim: 'A bounded claim' }), 'utf8');

    const calls = captureLearnCalls((kernel) => {
      jsonAdapter.ingestAndLearn(file, kernel, { rootPath: dir, actor: 'pin-test' });
    });

    const { text, opts } = calls[0];
    const built = buildProvenance(opts.provenance, {
      sourceType: opts.sourceType,
      sourceSubType: opts.sourceSubType,
      sourceRef: opts.sourceRef,
    });
    const provenance = built.provenance || built;

    assert.equal(provenance.contentHash, contentHash(text),
      'the hash the adapter computed is not the hash that would be stored');
  });
});

// ---------------------------------------------------------------------------
// The boundary. Stated here so it cannot drift into a stronger claim later.
// ---------------------------------------------------------------------------

test.describe('what a recorded content hash does not prove', () => {
  test('it does not make the record tamper-evident', () => {
    // The hash lives inside the record it describes. An editor who changes the
    // content and recomputes the hash produces a record that agrees with
    // itself, exactly as a resealed receipt bundle does. Demonstrated rather
    // than asserted in prose, so the limit is measured.
    const original = { sourceRef: 'file:/x/note.json:claim', content: 'A bounded claim' };
    const record = { ...original, contentHash: contentHash(original.content) };

    const forged = { ...record, content: 'A claim that was never made' };
    forged.contentHash = contentHash(forged.content);

    assert.equal(forged.contentHash, contentHash(forged.content),
      'the forged record is not self-consistent; this demonstration is broken');
    assert.notEqual(forged.content, original.content);
    assert.notEqual(forged.contentHash, record.contentHash);
    // A checker that only re-hashes what the record carries accepts the forgery.
    // Only a hash obtained from the source itself rejects it.
  });

  test('drift detection requires re-reading the source, not just the record', () => {
    const dir = makeTempDir('redetect');
    const file = path.join(dir, 'note.md');
    fs.writeFileSync(file, '# H\n\nAs recorded.\n', 'utf8');

    const recorded = captureLearnCalls((kernel) => {
      markdownAdapter.ingestAndLearn(file, kernel, { rootPath: dir });
    })[0].opts.provenance.contentHash;

    // Unchanged source: re-ingesting reaches the same hash.
    const same = captureLearnCalls((kernel) => {
      markdownAdapter.ingestAndLearn(file, kernel, { rootPath: dir });
    })[0].opts.provenance.contentHash;
    assert.equal(same, recorded);

    // Changed source: the comparison is what surfaces it. Nothing inside the
    // original record could have.
    fs.writeFileSync(file, '# H\n\nAs quietly rewritten.\n', 'utf8');
    const now = captureLearnCalls((kernel) => {
      markdownAdapter.ingestAndLearn(file, kernel, { rootPath: dir });
    })[0].opts.provenance.contentHash;
    assert.notEqual(now, recorded);
  });
});
