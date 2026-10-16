const DEFAULT_MAX_JSON_BODY = 4_096;
const DEFAULT_MAX_UPLOAD_BODY = 1_048_576;

async function readJsonBody(req, { maxBytes = DEFAULT_MAX_JSON_BODY, requireJson = true } = {}) {
  const contentType = String(req.headers?.['content-type'] || '').toLowerCase();
  if (requireJson && !contentType.includes('application/json')) {
    return {
      ok: false,
      status: 415,
      error: { error: 'Content-Type application/json required' },
    };
  }

  const declaredLength = Number(req.headers?.['content-length'] || 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    return {
      ok: false,
      status: 413,
      error: { error: 'Payload too large' },
    };
  }

  // Chunks are held as Buffers and decoded once, at 'end'.
  //
  // `body += chunk` decoded every chunk on its own, so a multi-byte UTF-8
  // character straddling a chunk boundary was split and each half decoded to
  // U+FFFD. The body was corrupted silently: JSON.parse still succeeded,
  // because U+FFFD is a perfectly valid character inside a JSON string, so no
  // endpoint produced an error code. HUQAN's primary language is Turkish, so
  // multi-byte characters are the norm rather than the exception, and every
  // POST surface past the first 64 KB chunk was exposed — including
  // learnDocument() text and the snapshotHash the ingest approval flow
  // computes over it, which was therefore hashing bytes the sender never sent
  // (#1023).
  //
  // Concatenating at the end does not weaken the memory bound: `maxBytes` was
  // always enforced over accumulated byte counts, and the buffer list is
  // released on overflow exactly as the string was.
  const chunks = [];
  let size = 0;

  return await new Promise(resolve => {
    let settled = false;
    let overflowed = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    req.on('data', chunk => {
      if (overflowed) return;
      // Real http requests emit Buffers; in-process callers and tests emit
      // strings. Normalizing here also makes `size` a byte count in both
      // cases, which is what `maxBytes` claims to bound.
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8');
      size += buf.length;
      if (size > maxBytes) {
        // Stop buffering, but do NOT destroy the request (#749).
        //
        // req.destroy() closed the socket before the route could write the 413
        // this function had just promised it, so a chunked client saw
        // ECONNRESET / socket hang up instead — the Content-Length fast path
        // above returned a clean 413 while the streaming path did not, making
        // the size limit transport-dependent. A caller cannot tell a policy
        // rejection from a transport failure, and retries on the latter
        // amplify load.
        //
        // Releasing the buffer here is what actually bounds memory; the
        // remaining inbound bytes are ignored, and the route writes its
        // response and closes the connection normally.
        overflowed = true;
        chunks.length = 0;
        finish({ ok: false, status: 413, error: { error: 'Payload too large' } });
        return;
      }
      chunks.push(buf);
    });

    req.on('end', () => {
      if (settled) return;
      try {
        const body = chunks.length ? Buffer.concat(chunks).toString('utf8') : '';
        const parsed = body ? JSON.parse(body) : {};
        finish({ ok: true, data: parsed });
      } catch (err) {
        finish({ ok: false, status: 400, error: { error: 'Invalid JSON: ' + err.message } });
      }
    });

    // A late error after an overflow (the peer giving up once we stop reading,
    // for instance) must not turn the settled 413 into a 400. finish() already
    // guards that; this keeps the listener from throwing on an unhandled
    // 'error' event.
    req.on('error', err => {
      finish({ ok: false, status: 400, error: { error: 'Request error: ' + err.message } });
    });
  });
}

module.exports = {
  DEFAULT_MAX_JSON_BODY,
  DEFAULT_MAX_UPLOAD_BODY,
  readJsonBody,
};
