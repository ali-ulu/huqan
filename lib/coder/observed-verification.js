'use strict';

/**
 * HUQAN Coder — observed-verification seam (#3031).
 *
 * Optional, caller-injected, out-of-band correctness signal. Runs after the
 * write lands and before the derivation record is finalized. The coder core
 * never spawns a process itself; whatever the seam executes runs on the
 * caller's authority, synchronously. A throwing seam, a promise, or a
 * non-object result is recorded as `ok: false` — it never crashes the
 * pipeline and never changes the derivation outcome or hash.
 */
function runObservedVerification({ verify, verifyCommand, root, task }) {
  const command = typeof verifyCommand === 'string' && verifyCommand !== '' ? verifyCommand : null;
  const none = { ran: false, ok: null, command: null, evidenceRef: null };
  if (typeof verify !== 'function') return none;
  let result;
  try {
    result = verify(root, task);
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return { ran: true, ok: false, command, evidenceRef: `verify seam threw: ${message}`.slice(0, 200) };
  }
  if (!result || typeof result !== 'object') return { ran: true, ok: false, command, evidenceRef: null };
  if (typeof result.then === 'function') {
    return { ran: true, ok: false, command, evidenceRef: 'verify seam must be synchronous' };
  }
  return {
    ran: true,
    ok: result.ok === true,
    command: typeof result.command === 'string' && result.command !== '' ? result.command : command,
    evidenceRef: typeof result.evidenceRef === 'string' && result.evidenceRef !== ''
      ? result.evidenceRef.slice(0, 200)
      : null,
  };
}

module.exports = {
  runObservedVerification,
};
