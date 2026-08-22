'use strict';

const DOC_EXTENSIONS = new Set(['md', 'mdx', 'txt', 'rst']);
const DOC_FILENAMES = new Set(['readme', 'changelog', 'license', 'contributing']);
const HELPER_DIRECTORY_SEGMENTS = new Set(['helper', 'helpers']);
const HELPER_FILENAMES = new Set([
  'helper.js',
  'helpers.js',
  'util.js',
  'utils.js',
  'normalizer.js',
  'formatter.js',
  'sanitizer.js',
]);

function splitPath(path) {
  return String(path ?? '')
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .toLowerCase()
    .split('/')
    .filter(Boolean);
}

function getPathExtension(filename) {
  const lastDot = filename.lastIndexOf('.');
  return lastDot > 0 ? filename.slice(lastDot + 1) : '';
}

function isDocsPath(path) {
  const filename = splitPath(path).at(-1) || '';
  const extension = getPathExtension(filename);
  return DOC_EXTENSIONS.has(extension) || (!extension && DOC_FILENAMES.has(filename));
}

function isHelperPath(path, changeType) {
  if (String(changeType ?? '').trim().toLowerCase() !== 'helper') return false;

  const segments = splitPath(path);
  const filename = segments.at(-1) || '';
  return HELPER_FILENAMES.has(filename)
    || segments.slice(0, -1).some(segment => HELPER_DIRECTORY_SEGMENTS.has(segment));
}

module.exports = {
  isDocsPath,
  isHelperPath,
};
