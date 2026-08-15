'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { buildIngestWorkflowPreview } = require('./ingest-workflow-preview');

const MAX_BATCH_ITEMS = 50;
const MAX_BATCH_BYTES = 1_048_576;
const SUPPORTED_SOURCES = new Set(['manual', 'decision']);
const STABLE_STATUSES = new Set(['completed', 'queued', 'review_required', 'blocked', 'paused', 'partial', 'failed', 'capability_not_available']);

function flagValue(args, name) {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function errorItem(id, sourceType, status, code, message) {
  return { id, sourceType, status, error: { code, message }, run: null, receipt: null };
}

function readBatch(args, readFile = fs.readFileSync) {
  const inputPath = flagValue(args, 'input');
  if (!inputPath) throw Object.assign(new Error('--input <json-file> is required.'), { code: 'INVALID_BATCH' });
  const filePath = path.resolve(process.cwd(), inputPath);
  const stat = fs.statSync(filePath);
  if (!stat.isFile() || stat.size > MAX_BATCH_BYTES) {
    throw Object.assign(new Error(`Batch input must be a file no larger than ${MAX_BATCH_BYTES} bytes.`), { code: 'INVALID_BATCH' });
  }
  const parsed = JSON.parse(readFile(filePath, 'utf8'));
  const items = Array.isArray(parsed) ? parsed : parsed?.items;
  if (!Array.isArray(items) || items.length < 1 || items.length > MAX_BATCH_ITEMS) {
    throw Object.assign(new Error(`Batch must contain 1-${MAX_BATCH_ITEMS} items.`), { code: 'INVALID_BATCH' });
  }
  return items;
}

function sourceTypeOf(item) {
  return String(item?.sourceType || item?.source || '').trim().toLowerCase();
}

function itemId(item, index) {
  return String(item?.id || `item-${index + 1}`);
}

function stableStatus(value) {
  const status = String(value || 'failed');
  return STABLE_STATUSES.has(status) ? status : 'failed';
}

function previewItem(item, index) {
  const id = itemId(item, index);
  const sourceType = sourceTypeOf(item);
  if (!SUPPORTED_SOURCES.has(sourceType)) {
    return errorItem(id, sourceType, 'capability_not_available', 'INGEST_SOURCE_UNSUPPORTED',
      'CLI batch ingest supports manual and decision sources only; external connector ingest is unavailable.');
  }
  const preview = buildIngestWorkflowPreview(item);
  if (!preview.ok) return errorItem(id, sourceType, 'failed', preview.code || 'INVALID_INGEST', preview.error || 'Ingest preview failed.');
  return {
    id, sourceType, status: 'review_required', error: null, run: null, receipt: null,
    sourceManifest: preview.sourceManifest, review: preview.review,
  };
}

function aggregateStatus(items) {
  const statuses = new Set(items.map(item => item.status));
  if (statuses.size === 1) return items[0].status;
  return 'partial';
}

async function requestJson(fetchImpl, url, options) {
  try {
    const response = await fetchImpl(url, options);
    const body = await response.json();
    return { response, body };
  } catch (error) {
    return { error };
  }
}

function httpOptions(token, body) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  return { method: body === undefined ? 'GET' : 'POST', headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

async function executeItem(item, index, context) {
  const preview = previewItem(item, index);
  if (preview.error) return preview;
  const { body, error } = await requestJson(context.fetchImpl, `${context.baseUrl}/api/v2/ingest/execute`, httpOptions(context.token, item));
  if (error) return errorItem(preview.id, preview.sourceType, 'failed', 'INGEST_REQUEST_FAILED', error.message);
  const status = stableStatus(body?.status);
  return {
    id: preview.id, sourceType: preview.sourceType, status,
    error: body?.error || null,
    run: body?.data?.runId ? { runId: body.data.runId, statusRoute: body.data.statusRoute || null } : null,
    receipt: body?.receiptId ? { receiptId: body.receiptId } : null,
  };
}

async function statusItem(item, index, context) {
  const id = itemId(item, index);
  const runId = String(item?.runId || '').trim();
  const workspaceId = String(item?.workspaceId || 'default').trim();
  if (!runId) return errorItem(id, sourceTypeOf(item), 'failed', 'INVALID_RUN', 'runId is required.');
  const url = `${context.baseUrl}/api/v2/ingest/runs/${encodeURIComponent(runId)}?workspaceId=${encodeURIComponent(workspaceId)}`;
  const { body, error } = await requestJson(context.fetchImpl, url, httpOptions(context.token));
  if (error) return errorItem(id, sourceTypeOf(item), 'failed', 'INGEST_STATUS_REQUEST_FAILED', error.message);
  return {
    id, sourceType: body?.data?.sourceManifest?.sourceType || sourceTypeOf(item), status: stableStatus(body?.status),
    error: body?.error || null,
    run: body?.data ? { runId: body.data.runId || runId, phase: body.data.phase || null, progress: body.data.progress || null } : { runId },
    receipt: body?.receiptId ? { receiptId: body.receiptId } : null,
  };
}

async function runIngestBatch(args, deps = {}) {
  const action = String(args[2] || '').toLowerCase();
  if (!['preview', 'execute', 'status'].includes(action)) {
    throw Object.assign(new Error('Use ingest batch preview|execute|status.'), { code: 'INVALID_BATCH' });
  }
  const items = readBatch(args, deps.readFile);
  if (action === 'preview') {
    const results = items.map(previewItem);
    return { action, status: aggregateStatus(results), items: results };
  }
  const baseUrl = String(flagValue(args, 'base-url') || deps.baseUrl || '').replace(/\/$/, '');
  const token = flagValue(args, 'api-key') || deps.apiKey || '';
  const fetchImpl = deps.fetch || globalThis.fetch;
  if (!baseUrl || typeof fetchImpl !== 'function') {
    throw Object.assign(new Error('--base-url is required for execute and status.'), { code: 'INVALID_BATCH' });
  }
  const context = { baseUrl, token, fetchImpl };
  const results = [];
  for (let index = 0; index < items.length; index += 1) {
    results.push(action === 'execute'
      ? await executeItem(items[index], index, context)
      : await statusItem(items[index], index, context));
  }
  return { action, status: aggregateStatus(results), items: results };
}

module.exports = { MAX_BATCH_ITEMS, aggregateStatus, previewItem, runIngestBatch };
