'use strict';

/**
 * The bounded A2A exchange evaluator moved to lib/a2a/bounded-exchange.js when
 * it gained a production caller (P0-B): a module under scripts/ is a standalone
 * artifact, so requiring it from the server would not have made the lib/v5
 * modules it depends on reachable.
 *
 * This shim keeps the harness pointed at one implementation. The harness is
 * still the semantic regression owner for these rules -- it just no longer owns
 * where they live.
 */

module.exports = require('../../lib/a2a/bounded-exchange');
