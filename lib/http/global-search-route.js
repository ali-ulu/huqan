'use strict';

const { writeJson } = require('../server-response-helpers');
const { searchMemory } = require('./read-workflow-actions');
const { sanitizeInput } = require('../../requestGuards');

function createGlobalSearchRoute({ kernel }) {
  return async function handleGlobalSearch(req, res) {
    const reqUrl = new URL(req.url, 'http://localhost');
    if (reqUrl.pathname !== '/api/global-search') {
      return null;
    }
    if (req.method !== 'GET') {
      res.writeHead(405, { 'Content-Type': 'application/json', Allow: 'GET' });
      res.end(JSON.stringify({ ok: false, error: { code: 'METHOD_NOT_ALLOWED', message: 'Use GET' } }));
      return true;
    }
    const workspaceId = sanitizeInput(reqUrl.searchParams.get('workspaceId') || 'default', 128) || 'default';
    const q = sanitizeInput(reqUrl.searchParams.get('q') || '', 300);
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST', message: 'q is required' } }));
      return true;
    }
    try {
      const search = searchMemory(kernel.graph, { workspaceId, query: q });
      if (!search) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: { code: 'BAD_REQUEST', message: 'Invalid query' } }));
        return true;
      }
      const items = search.items.map(it => ({
        id: it.id,
        label: it.label,
        sourceRef: it.sourceRef,
        provenanceId: it.provenanceId,
        workspaceId,
        _match: it.label || it.id,
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, data: { items, returned: items.length, truncated: search.truncated } }));
      return true;
    } catch (err) {
      // The cause stays in the server log; the client gets a fixed message.
      console.error('[global-search] search failed:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: { code: 'INTERNAL_ERROR', message: 'Search failed' } }));
      return true;
    }
  };
}

module.exports = { createGlobalSearchRoute };
