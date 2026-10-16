'use strict';

const path = require('node:path');
const { readFileSync } = require('node:fs');

const UI_PATHNAME = '/pr-guardian';
const UI_FILE = path.join(__dirname, '..', '..', 'public', 'pr-guardian', 'index.html');

function createPrGuardianUiRoute({ fail }) {
  return function routeUi(req, res) {
    if (req.method !== 'GET') {
      fail(req, res, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed');
      return true;
    }
    try {
      const html = readFileSync(UI_FILE);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(html);
    } catch (_) {
      fail(req, res, 503, 'PR_GUARDIAN_UI_UNAVAILABLE', 'Review Console UI is unavailable.');
    }
    return true;
  };
}

module.exports = { UI_PATHNAME, createPrGuardianUiRoute };
