'use strict';

/**
 * GET /fitness-dashboard — read-only fitness history dashboard.
 *
 * Renders lib/fitness-history.js into a self-contained HTML dashboard via
 * scripts/fitness-dashboard.js. It reads history and thresholds only; it never
 * mutates the graph or a threshold. The route is declared authenticated in
 * lib/http/route-auth-policy.js (fitness history is graph health data, so even
 * the default workspace stays behind an API key).
 */

const { fitnessHistoryPath, readFitnessHistory } = require('../fitness-history');
const { buildFitnessDashboard } = require('../../scripts/fitness-dashboard');
const { readStoredThresholds } = require('../hypothesis-thresholds');
const { writeStructuredLog, createRequestCorrelation } = require('./structured-log');

function createFitnessDashboardRoute({
  kernel,
  writeJson,
  buildCorsHeaders,
  JSON_CONTENT_TYPE,
}) {
  return function handleFitnessDashboardRoute(req, res, reqUrl) {
    if (reqUrl.pathname !== '/fitness-dashboard') return false;

    const correlation = createRequestCorrelation(req, res);

    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': JSON_CONTENT_TYPE, ...buildCorsHeaders(req) });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return true;
    }

    try {
      // Fail-closed on a missing history store: render an empty dashboard
      // rather than a 500, so a deployment without a fitness history still
      // shows the surface without leaking a store error.
      let entries = [];
      let thresholds;
      try {
        entries = readFitnessHistory(fitnessHistoryPath(kernel), 200);
      } catch (_noStore) {
        entries = [];
      }
      try {
        thresholds = readStoredThresholds(kernel, 'default');
      } catch (_noThresholds) {
        thresholds = undefined;
      }
      const html = buildFitnessDashboard(entries, { thresholds, title: 'HUQAN Fitness Panosu' });
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        ...buildCorsHeaders(req),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(html);
    } catch (err) {
      writeStructuredLog(console, 'error', 'http.fitness_dashboard_error', correlation, {
        route: '/fitness-dashboard',
        method: req.method,
        errorCode: err?.code || 'FITNESS_DASHBOARD_FAILED',
      });
      writeJson(req, res, 500, { error: 'Internal server error' });
    }
    return true;
  };
}

module.exports = { createFitnessDashboardRoute };
