'use strict';

/**
 * The subject a question falls back to when none can be detected.
 *
 * This is the product's own identity in the graph. Nothing seeds it -- an empty
 * graph has neither node -- so it is a label on the answer ("subject": ...,
 * "unknown": true) far more often than it is a lookup that hits. It is still a
 * lookup, though: a graph that was taught about the product resolves it, and a
 * graph written before RFC-001's rename holds that node under the legacy name.
 *
 * Canonical first, legacy accepted -- RFC-001 decision 7, applied to a node id
 * rather than a spelling. A writer emits `huqan`; a reader still finds `axiom`
 * if that is what an older graph has, so the rename cannot make an existing
 * install stop answering a question it used to answer.
 */
const IDENTITY_SUBJECT = 'huqan';
const LEGACY_IDENTITY_SUBJECT = 'axiom';

/**
 * @param {object} currentGraph the graph this call is reading
 * @returns {string} the canonical identity subject, or the legacy one when
 *   only that node exists in this graph.
 */
function identitySubject(currentGraph, workspaceId = 'default') {
  if (!currentGraph || typeof currentGraph.getNode !== 'function') return IDENTITY_SUBJECT;
  if (currentGraph.getNode(IDENTITY_SUBJECT, workspaceId)) return IDENTITY_SUBJECT;
  if (currentGraph.getNode(LEGACY_IDENTITY_SUBJECT, workspaceId)) return LEGACY_IDENTITY_SUBJECT;
  return IDENTITY_SUBJECT;
}

function createSubjectResolver(currentGraph, workspaceId, normalizeWord) {
  const kokeIndirge = (value) => {
    let root = value
      .replace(/mezsem$/, 'me')
      .replace(/mazsam$/, 'ma')
      .replace(/sem$/, '')
      .replace(/sam$/, '')
      .replace(/meliyim$/, 'me')
      .replace(/mal\u0131y\u0131m$/, 'ma')
      .replace(/yim$/, '')
      .replace(/y\u0131m$/, '')
      .replace(/yum$/, '')
      .replace(/y\u00fcm$/, '')
      .replace(/m$/, '')
      .replace(/im$/, '')
      .replace(/s\u0131n$/, '')
      .replace(/sin$/, '')
      .replace(/sun$/, '')
      .replace(/s\u00fcn$/, '')
      .replace(/yorsun$/, '')
      .replace(/yor$/, '');

    if (root.endsWith('meliyim')) root = root.slice(0, -7);
    return root.trim();
  };

  const ozneBul = (value) => {
    const parts = value.split(/\s+/).filter(Boolean);
    if (parts.length === 0) return { subject: identitySubject(currentGraph, workspaceId), verb: '' };

    const first = parts[0];
    const normalized = normalizeWord(first);
    if (currentGraph.getNode(normalized, workspaceId)) {
      return { subject: normalized, verb: parts.slice(1).join(' ') };
    }

    const verbRoot = kokeIndirge(first);
    const normalizedRoot = normalizeWord(verbRoot);
    if (currentGraph.getNode(normalizedRoot, workspaceId)) {
      return { subject: identitySubject(currentGraph, workspaceId), verb: normalizedRoot };
    }

    if (parts.length > 1) {
      const last = parts[parts.length - 1];
      const lastRoot = kokeIndirge(last);
      const normalizedLast = normalizeWord(lastRoot);
      const adjective = parts.slice(0, -1).join(' ') + ' ' + lastRoot;
      if (currentGraph.getNode(normalizedLast, workspaceId)) {
        return { subject: identitySubject(currentGraph, workspaceId), verb: adjective, sifat: parts.slice(0, -1).join(' ') };
      }

      return { subject: identitySubject(currentGraph, workspaceId), verb: value };
    }

    return { subject: normalized, verb: '' };
  };
  return ozneBul;
}

module.exports = { identitySubject, createSubjectResolver };
