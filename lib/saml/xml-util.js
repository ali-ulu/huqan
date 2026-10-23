'use strict';

const { XMLParser } = require('fast-xml-parser');

// Minimal, fail-closed base64 decode for the SAMLResponse form field.
// `Buffer.from(str, 'base64')` silently ignores invalid characters, which
// would let a truncated or tampered response parse to a shorter, valid
// document. We reject any input that is not unpadded standard base64.

const B64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function decodeB64Strict(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  // Strip line breaks (some IdPs wrap at 76 chars).
  const stripped = value.replace(/\s+/g, '');
  if (stripped.length % 4 !== 0 || !B64_RE.test(stripped)) return null;
  const buffer = Buffer.from(stripped, 'base64');
  // Round-trip check: a real base64 string re-encodes to itself.
  if (buffer.toString('base64') !== stripped) return null;
  return buffer;
}

function decodeSamlResponse(value) {
  const buffer = decodeB64Strict(value);
  if (!buffer) return { ok: false, code: 'malformed_response', message: 'SAMLResponse is not valid base64' };
  const xml = buffer.toString('utf8');
  // The XML declaration must declare UTF-8 (or nothing); a UTF-16 body
  // smuggled through base64 would make two parsers disagree.
  if (xml.charCodeAt(0) === 0xfeff) {
    return { ok: false, code: 'malformed_response', message: 'SAMLResponse must not carry a BOM' };
  }
  if (!xml.startsWith('<')) {
    return { ok: false, code: 'malformed_response', message: 'SAMLResponse does not begin with an XML element' };
  }
  return { ok: true, xml };
}

function parseSamlXml(xml) {
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
    textNodeName: '#text',
    parseAttributeValue: false,
    trimValues: true,
    isArray: (name) => ['Attribute', 'Audience', 'SubjectConfirmation', 'AttributeStatement'].includes(name),
  });
  return parser.parse(xml);
}

function asArray(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textOf(node) {
  if (node === undefined || node === null) return undefined;
  if (typeof node === 'string') return node;
  if (node['#text'] !== undefined) return node['#text'];
  return undefined;
}

function parseInstant(value) {
  if (typeof value !== 'string') return Number.NaN;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value)) return Number.NaN;
  return Date.parse(value);
}

module.exports = {
  B64_RE,
  decodeB64Strict,
  decodeSamlResponse,
  parseSamlXml,
  asArray,
  textOf,
  parseInstant,
};
