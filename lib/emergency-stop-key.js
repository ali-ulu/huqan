'use strict';

/**
 * The key an emergency stop is recorded and looked up under.
 *
 * A stop is an exact string match, so an id that differs from the stopped one
 * only by a control character reads as "not stopped" while every other layer
 * still treats it as the same agent. #4235 closed that shape at one MCP call
 * site; the key is where it belongs, because the lookup cannot tell a
 * deliberate variant from a malformed one.
 *
 * Refusing is the fail-closed direction: a caller that names an id this module
 * rejects gets no verdict to act on, rather than an "all clear" it could.
 */

// oxlint-disable-next-line no-control-regex -- deliberate: the control-character class a stop key may not contain
const STOP_KEY_CONTROL_PATTERN = /[\u0000-\u001f\u007f]/;

function stopKey(value) {
  if (STOP_KEY_CONTROL_PATTERN.test(value)) {
    throw new TypeError('an emergency stop id must not contain control characters');
  }
  return value;
}

module.exports = { stopKey };
