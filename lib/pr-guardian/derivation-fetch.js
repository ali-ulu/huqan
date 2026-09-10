'use strict';

/**
 * PR Guardian — reading the head side of a pull request as data.
 *
 * The self-review job checks out the BASE tree and never the pull request, so a
 * change cannot supply the policy that judges it. Re-deriving still needs the
 * head-side file contents, so they are fetched over the API and parsed as data.
 * Nothing from head is executed, required, or written to disk.
 *
 * Everything is fetched up front because `verifyDerivation` is synchronous by
 * design -- it is a pure function so that it can be run anywhere, including in
 * a test with no network -- and making it async to accommodate one caller would
 * push I/O into the one place that has stayed free of it.
 *
 * Failure is never silent. If any record or any file it needs cannot be read,
 * `complete` comes back false and the policy reports `unknown` rather than
 * treating a short list as a clean result.
 */

const { isDerivationRecordPath } = require('./derivation-check');

const RAW_ACCEPT = 'application/vnd.github.raw';

/**
 * Fetch one path at one ref. Returns the text, or null when the file is not
 * there (a 404 is an ordinary answer for a file the change creates), or throws
 * for anything else -- a 403 or a 500 is not evidence of absence.
 */
async function fetchFileAtRef({ api, repo, ref, path, token, fetchImpl = fetch }) {
  const url = `${api}/repos/${repo}/contents/${encodeURI(path)}?ref=${encodeURIComponent(ref)}`;
  const response = await fetchImpl(url, {
    headers: {
      accept: RAW_ACCEPT,
      authorization: `Bearer ${token}`,
      'user-agent': 'huqan-pr-guardian',
    },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub content read failed for ${path}: HTTP ${response.status}`);
  return response.text();
}

/** Every head-side path a record needs in order to be re-derived and compared. */
function pathsNeededBy(record) {
  const declared = Array.isArray(record?.allowedPaths) ? record.allowedPaths.map(String) : [];
  const changed = Array.isArray(record?.patch) ? record.patch.map(change => String(change?.path || '')) : [];
  return [...new Set([...declared, ...changed])].filter(Boolean);
}

/**
 * Collect the derivation records a pull request carries, plus the head-side
 * files needed to check them.
 *
 * @returns {{records: Array<{path: string, record: object}>, headFiles: Map<string, string>, complete: boolean}}
 */
async function collectDerivations({ api, repo, ref, token, files, fetchImpl = fetch, maxRecords = 50 }) {
  const candidates = (Array.isArray(files) ? files : [])
    .map(file => String(file?.filename || ''))
    .filter(isDerivationRecordPath);

  if (candidates.length === 0) return { records: [], headFiles: new Map(), complete: true };
  // A bound, so a pull request cannot turn this check into an unbounded number
  // of API calls. Hitting it is reported as incomplete, not quietly truncated.
  if (candidates.length > maxRecords) return { records: [], headFiles: new Map(), complete: false };

  const records = [];
  const headFiles = new Map();
  let complete = true;

  for (const path of candidates) {
    let raw;
    try {
      raw = await fetchFileAtRef({ api, repo, ref, path, token, fetchImpl });
    } catch {
      complete = false;
      continue;
    }
    // A deleted record file appears in the file list but has no content at head.
    // That is a removal, not a failure to read.
    if (raw === null) continue;
    try {
      records.push({ path, record: JSON.parse(raw) });
    } catch {
      // Unparseable record: the change carries something claiming to be a
      // record that is not one. Reported as incomplete rather than skipped,
      // because "we could not check this" is the honest reading.
      complete = false;
    }
  }

  for (const entry of records) {
    for (const needed of pathsNeededBy(entry.record)) {
      if (headFiles.has(needed)) continue;
      try {
        const content = await fetchFileAtRef({ api, repo, ref, path: needed, token, fetchImpl });
        if (content !== null) headFiles.set(needed, content);
      } catch {
        complete = false;
      }
    }
  }

  return { records, headFiles, complete };
}

/** Synchronous reader over the pre-fetched head files, for verifyDerivation. */
function headReader(headFiles) {
  return function read(path) {
    const value = headFiles.get(String(path || ''));
    return typeof value === 'string' ? value : null;
  };
}

module.exports = Object.freeze({
  collectDerivations,
  fetchFileAtRef,
  headReader,
  pathsNeededBy,
});
