'use strict';

/**
 * Static asset surface for the bundled dashboard.
 *
 * `public/index.html` used to be genuinely self-contained: one file, styles and
 * script inline, served by one branch in server.js. Splitting it into linked
 * assets (#1894 extracted the CSS) introduced a class of failure the HTML alone
 * cannot show -- the markup stays complete and every source-text contract test
 * keeps passing while the browser gets a 404 for the asset and renders the page
 * unstyled. That is exactly what shipped: nothing served `/css/app.css`.
 *
 * So the split is only half a change. The other half is here: a path is served
 * because it appears in this table, and `test/dashboard-static-assets.test.js`
 * asserts over real HTTP that every same-origin `href`/`src` in the dashboard
 * HTML has an entry that resolves. Adding a linked asset without an entry fails
 * that test rather than shipping a blank panel.
 *
 * The table is an explicit allowlist, not a directory walker, for the same
 * reason the route table in route-auth-policy.js is: the served surface should
 * be a reviewable list. It also means no request path ever reaches the file
 * system, so directory traversal has nothing to traverse.
 */

const path = require('path');
const { readFileSync } = require('fs');

const PUBLIC_ROOT = path.join(__dirname, '..', '..', 'public');

const STATIC_ASSETS = Object.freeze([
  Object.freeze({
    pathname: '/',
    file: Object.freeze(['index.html']),
    contentType: 'text/html; charset=utf-8',
    logCode: 'INDEX_FAILED',
  }),
  Object.freeze({
    pathname: '/css/app.css',
    file: Object.freeze(['css', 'app.css']),
    contentType: 'text/css; charset=utf-8',
    logCode: 'STATIC_ASSET_FAILED',
  }),
  Object.freeze({
    pathname: '/js/app.js',
    file: Object.freeze(['js', 'app.js']),
    contentType: 'text/javascript; charset=utf-8',
    logCode: 'STATIC_ASSET_FAILED',
  }),
]);

const ASSETS_BY_PATHNAME = new Map(STATIC_ASSETS.map(asset => [asset.pathname, asset]));

// These are build artifacts, not request-scoped data, so the bytes are read once
// and kept instead of doing sync I/O per request (#420).
//
// Cached lazily rather than at module load: server.js is required directly by
// the test suite, and reading at load time would turn a missing/unreadable file
// into a require-time crash instead of a 500 on the route. A failed read is not
// cached either, so fixing the file recovers without a restart.
const cachedBytes = new Map();

function readAsset(asset) {
  if (!cachedBytes.has(asset.pathname)) {
    cachedBytes.set(asset.pathname, readFileSync(path.join(PUBLIC_ROOT, ...asset.file)));
  }
  return cachedBytes.get(asset.pathname);
}

function isStaticAssetPath(pathname) {
  return ASSETS_BY_PATHNAME.has(String(pathname || ''));
}

function listStaticAssetPaths() {
  return STATIC_ASSETS.map(asset => asset.pathname);
}

/** The cached index page bytes; kept as a named export because server.test.js asserts the caching. */
function getHtmlPage() {
  return readAsset(ASSETS_BY_PATHNAME.get('/'));
}

/**
 * Answer a declared static path.
 *
 * Returns false when the path is not declared, so the caller falls through to
 * its generic 404 -- an undeclared path must stay indistinguishable from one
 * that was never routed.
 */
function handleStaticAssetRequest(req, res, pathname, { buildCorsHeaders, writeJson, onError }) {
  const asset = ASSETS_BY_PATHNAME.get(String(pathname || ''));
  if (asset === undefined) return false;
  try {
    res.writeHead(200, { 'Content-Type': asset.contentType, ...buildCorsHeaders(req), 'Cache-Control': 'no-cache' });
    res.end(readAsset(asset));
  } catch (err) {
    onError(asset, err);
    writeJson(req, res, 500, { error: 'Internal server error' });
  }
  return true;
}

module.exports = {
  STATIC_ASSETS,
  isStaticAssetPath,
  listStaticAssetPaths,
  getHtmlPage,
  handleStaticAssetRequest,
};
