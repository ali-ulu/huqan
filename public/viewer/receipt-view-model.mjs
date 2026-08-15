export const TERMINAL_STATES = Object.freeze([
  'unauthorized',
  'invalid_request',
  'not_found',
  'chain_invalid',
  'read_error',
  'found',
]);

function ownDataValue(object, key) {
  if (!object || typeof object !== 'object' || Array.isArray(object)) {
    return { ok: false, value: undefined };
  }
  const descriptor = Object.getOwnPropertyDescriptor(object, key);
  return descriptor && Object.hasOwn(descriptor, 'value')
    ? { ok: true, value: descriptor.value }
    : { ok: false, value: undefined };
}

function errorCode(body) {
  const error = ownDataValue(body, 'error');
  if (!error.ok) return undefined;
  const code = ownDataValue(error.value, 'code');
  return code.ok ? code.value : undefined;
}

export function mapReceiptResponse(input) {
  try {
    const status = ownDataValue(input, 'statusCode');
    const bodyProperty = ownDataValue(input, 'body');
    if (!status.ok || !bodyProperty.ok) return { state: 'read_error', receipt: null };

    const statusCode = status.value;
    const body = bodyProperty.value;
    const ok = ownDataValue(body, 'ok');
    const receipt = ownDataValue(body, 'receipt');
    if (
      statusCode === 200
      && ok.ok && ok.value === true
      && receipt.ok && receipt.value && typeof receipt.value === 'object'
      && !Array.isArray(receipt.value)
    ) {
      return { state: 'found', receipt: receipt.value };
    }

    const code = errorCode(body);
    if (statusCode === 401 && code === 'unauthorized') {
      return { state: 'unauthorized', receipt: null };
    }
    if (statusCode === 400 && code === 'invalid_receipt_id') {
      return { state: 'invalid_request', receipt: null };
    }
    if (statusCode === 404 && code === 'receipt_not_found') {
      return { state: 'not_found', receipt: null };
    }
    // The receipt exists and may even parse on its own, but its chain does
    // not validate. It gets its own state so the viewer names the integrity
    // failure instead of reporting a canonical observation (#766).
    if (statusCode === 409 && code === 'receipt_chain_invalid') {
      return { state: 'chain_invalid', receipt: null };
    }
  } catch {
    return { state: 'read_error', receipt: null };
  }
  return { state: 'read_error', receipt: null };
}
