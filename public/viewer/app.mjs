import { mapReceiptResponse } from './receipt-view-model.mjs';

export const RECEIPT_FIELDS = Object.freeze([
  'receiptId', 'receiptKind', 'decision', 'status', 'createdAt', 'workspaceId',
  'reason', 'admissionId', 'actor', 'agentId', 'provenanceId',
  'trustPolicyVersion', 'approvalId', 'approvalStatus', 'memoryDraftId',
  'riskScore', 'canonical', 'reviewed', 'quarantined', 'rejected',
]);

// The viewer carries its own tiny catalogue reader rather than loading the
// dashboard's i18n.js: V4-UI-2 pins this page to four assets and one module, so
// a second script tag would widen a surface that is deliberately narrow. The
// fetch is the only new thing, and connect-src 'self' already permits it.
//
// English stays inline as the fallback: this module is imported by unit tests
// that have no window, and the page renders before the catalogue arrives.
const SUPPORTED_LOCALES = ['tr', 'en'];
let messages = null;

const T = (key, fallback) => {
  if (!messages) return fallback;
  const value = key.split('.').reduce((node, part) => (node && typeof node === 'object' && part in node ? node[part] : undefined), messages);
  return typeof value === 'string' ? value : fallback;
};

/**
 * The browser's language, and nothing else. The dashboard remembers a choice in
 * storage, but V4-UI-2 keeps every storage API out of this module, so the
 * viewer reads the request's own signal rather than reaching for that memory.
 */
function resolveLocale() {
  const language = String(navigator.language || '').split('-')[0].toLowerCase();
  return SUPPORTED_LOCALES.includes(language) ? language : 'tr';
}

/**
 * Translates the static shell with textContent only. Every annotated element is
 * a leaf, so no child is ever destroyed, and no markup is ever assigned —
 * V4-UI-2 keeps every markup-writing property out of this module, which is also
 * why a two-line heading is two annotated spans rather than one key with a tag
 * inside it.
 */
function applyTranslations(documentRef) {
  for (const element of documentRef.querySelectorAll('[data-i18n]')) {
    const text = T(element.dataset.i18n, null);
    if (text !== null) element.textContent = text;
  }
}

export async function loadCatalogue(documentRef, fetchImpl = fetch) {
  const locale = resolveLocale();
  try {
    const response = await fetchImpl(`/locales/${locale}.json`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    messages = await response.json();
  } catch {
    // A catalogue that will not load leaves the inline English in place, which
    // is a readable page rather than a screen of raw keys.
    return null;
  }
  documentRef.documentElement.lang = locale;
  applyTranslations(documentRef);
  return locale;
}

// The state key is the contract; only its copy is localised, and it is resolved
// at render time so a catalogue that lands late still wins.
const STATE_MESSAGES = Object.freeze({
  unauthorized: () => T('viewer.messages.unauthorized', 'Open a viewer session to inspect receipts.'),
  invalid_request: () => T('viewer.messages.invalidRequest', 'Enter a valid receipt identifier.'),
  not_found: () => T('viewer.messages.notFound', 'No receipt was found for this bounded lookup.'),
  chain_invalid: () => T('viewer.messages.chainInvalid', 'Receipt chain integrity failed. This receipt is not authoritative and its fields are withheld.'),
  read_error: () => T('viewer.messages.readError', 'The receipt could not be read safely.'),
  found: () => T('viewer.messages.found', 'Canonical receipt observed.'),
});

function ownPrimitive(receipt, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(receipt, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) return undefined;
    const value = descriptor.value;
    return ['string', 'number', 'boolean'].includes(typeof value) ? value : undefined;
  } catch {
    return undefined;
  }
}

export function buildReceiptPath(receiptId, workspaceId = '') {
  const base = `/viewer/api/trust-receipt/${encodeURIComponent(String(receiptId))}`;
  return workspaceId ? `${base}?workspaceId=${encodeURIComponent(String(workspaceId))}` : base;
}

export function renderViewState(documentRef, statusNode, detailsNode, viewState) {
  let state = 'read_error';
  let receipt = null;
  try {
    const stateDescriptor = Object.getOwnPropertyDescriptor(viewState, 'state');
    const receiptDescriptor = Object.getOwnPropertyDescriptor(viewState, 'receipt');
    if (stateDescriptor && Object.hasOwn(stateDescriptor, 'value') && STATE_MESSAGES[stateDescriptor.value]) {
      state = stateDescriptor.value;
    }
    if (receiptDescriptor && Object.hasOwn(receiptDescriptor, 'value')) receipt = receiptDescriptor.value;
  } catch {
    state = 'read_error';
  }
  statusNode.textContent = STATE_MESSAGES[state]();
  statusNode.dataset.state = state;
  detailsNode.replaceChildren();
  if (state !== 'found' || !receipt || typeof receipt !== 'object') return;

  for (const key of RECEIPT_FIELDS) {
    const value = ownPrimitive(receipt, key);
    if (value === undefined) continue;
    const pair = documentRef.createElement('div');
    pair.className = 'receipt-pair';
    const term = documentRef.createElement('dt');
    term.textContent = key;
    const description = documentRef.createElement('dd');
    description.textContent = String(value);
    pair.append(term, description);
    detailsNode.append(pair);
  }
}

async function readJsonResponse(response) {
  try {
    return { statusCode: response.status, body: await response.json() };
  } catch {
    return { statusCode: response.status, body: null };
  }
}

export function startViewer(documentRef, fetchRef) {
  const loginForm = documentRef.getElementById('login-form');
  const receiptForm = documentRef.getElementById('receipt-form');
  const logoutButton = documentRef.getElementById('logout-button');
  const apiKeyInput = documentRef.getElementById('api-key');
  const loginWorkspaceIdInput = documentRef.getElementById('login-workspace-id');
  const receiptIdInput = documentRef.getElementById('receipt-id');
  const workspaceIdInput = documentRef.getElementById('workspace-id');
  const statusNode = documentRef.getElementById('status');
  const detailsNode = documentRef.getElementById('receipt-details');

  const render = (state) => renderViewState(documentRef, statusNode, detailsNode, state);
  const renderSessionReady = () => {
    statusNode.textContent = T('viewer.messages.sessionOpened', 'Viewer session opened. Enter a receipt identifier.');
    statusNode.dataset.state = '';
    detailsNode.replaceChildren();
  };

  loginForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const apiKey = apiKeyInput.value;
    // The session is bound to whatever workspace is declared here (#404);
    // it cannot be widened later by a per-lookup ?workspaceId= override.
    const workspaceId = loginWorkspaceIdInput ? loginWorkspaceIdInput.value.trim() : '';
    try {
      const response = await fetchRef('/viewer/session', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey, workspaceId }),
      });
      if (response.ok) renderSessionReady();
      else render(mapReceiptResponse(await readJsonResponse(response)));
    } catch {
      render({ state: 'read_error', receipt: null });
    } finally {
      apiKeyInput.value = '';
    }
  });

  receiptForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const receiptId = receiptIdInput.value.trim();
    if (!receiptId) {
      render({ state: 'invalid_request', receipt: null });
      return;
    }
    try {
      const response = await fetchRef(buildReceiptPath(receiptId, workspaceIdInput.value.trim()), {
        credentials: 'same-origin',
      });
      render(mapReceiptResponse(await readJsonResponse(response)));
    } catch {
      render({ state: 'read_error', receipt: null });
    }
  });

  logoutButton.addEventListener('click', async () => {
    try {
      await fetchRef('/viewer/session', { method: 'DELETE', credentials: 'same-origin' });
    } catch {
      // The local session view closes even if the request cannot complete.
    } finally {
      render({ state: 'unauthorized', receipt: null });
    }
  });

  render({ state: 'unauthorized', receipt: null });
}

if (typeof document !== 'undefined' && typeof fetch === 'function') {
  startViewer(document, fetch);
  // After startViewer, so the catalogue repaints the status line it just wrote
  // rather than being overwritten by it.
  loadCatalogue(document).then(() => {
    const statusNode = document.getElementById('status');
    if (statusNode && statusNode.dataset.state) {
      renderViewState(document, statusNode, document.getElementById('receipt-details'), { state: statusNode.dataset.state, receipt: null });
    }
  });
}
