'use strict';

// HTML to text sections for adapters/http-adapter.js (#2401). Pure: no I/O.

function decodeEntities(text) {
  const named = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return String(text || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] === '#') {
      const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
      return Number.isInteger(code) && code >= 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : whole;
    }
    const key = body.toLowerCase();
    return Object.hasOwn(named, key) ? named[key] : whole;
  });
}

function stripTags(html) {
  return decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * Splits fetched HTML into sections by <h1>-<h3> headings, mirroring
 * markdown-adapter's heading-based model. Falls back to one 'root' entry
 * for the whole page when no headings are found. Regex-based rather than a
 * DOM parser -- this only needs readable text, not layout or a full parse
 * tree, and adding an HTML parsing dependency for that would be scope
 * beyond what the ingest use case needs.
 */
function parseHtml(html, sourceUrl) {
  const body = String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ');

  const headingMatches = [...body.matchAll(/<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/gi)];
  if (headingMatches.length === 0) {
    const text = stripTags(body);
    return text ? [{ entryKey: 'root', filePath: sourceUrl, content: text, sourceRef: `${sourceUrl}#root` }] : [];
  }

  const entries = [];
  headingMatches.forEach((match, i) => {
    const heading = stripTags(match[1]) || `section-${i + 1}`;
    const start = match.index + match[0].length;
    const end = i + 1 < headingMatches.length ? headingMatches[i + 1].index : body.length;
    const text = stripTags(body.slice(start, end));
    if (!text) return;
    entries.push({
      entryKey: heading,
      filePath: sourceUrl,
      content: text,
      sourceRef: `${sourceUrl}#${encodeURIComponent(heading)}`,
    });
  });
  return entries;
}

module.exports = { parseHtml };
