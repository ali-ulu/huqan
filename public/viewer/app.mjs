import { mapReceiptResponse } from './receipt-view-model.mjs';

export const RECEIPT_FIELDS = Object.freeze([
  'receiptId', 'receiptKind', 'decision', 'status', 'createdAt', 'workspaceId',
  'reason', 'admissionId', 'actor', 'agentId', 'provenanceId',
  'trustPolicyVersion', 'approvalId', 'approvalStatus', 'memoryDraftId',
  'riskScore', 'canonical', 'reviewed', 'quarantined', 'rejected',
]);

const STATE_MESSAGES = Object.freeze({
  unauthorized: 'Open a viewer session to inspect receipts.',
  invalid_request: 'Enter a valid receipt identifier.',
  not_found: 'No receipt was found for this bounded lookup.',
  chain_invalid: 'Receipt chain integrity failed. This receipt is not authoritative and its fields are withheld.',
  read_error: 'The receipt could not be read safely.',
  found: 'Canonical receipt observed.',
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
  statusNode.textContent = STATE_MESSAGES[state];
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
    statusNode.textContent = 'Viewer session opened. Enter a receipt identifier.';
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
}
