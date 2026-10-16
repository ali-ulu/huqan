'use strict';

/**
 * A layer violation carried by a file split is not new debt.
 *
 * When `lib/foo.js` is split and the offending require moves into the new
 * `lib/foo-bar.js`, the gate used to see one new violation (`foo-bar -> T`)
 * and one unrecorded gain (`foo -> T`), and fail on both although the debt
 * did not grow (#2819, #2826). This module pairs the two up.
 *
 * A new violation `X -> T` is carried from a recorded one `Y -> T` only when
 * all of these hold, so nothing but a split can use it:
 *   - `Y -> T` is recorded and no longer live,
 *   - `X` is a module the recorded graph has never seen,
 *   - `X` is named after `Y`: same directory and stem (`lib/foo-bar.js`,
 *     `lib/foo/bar.js` for `lib/foo.js`),
 *   - both edges leave the same ring (`fromLayer` matches; the target is the
 *     same file, so the ring it lands in is too -- a target that changed
 *     ring is caught separately as "reassigned"),
 *   - each vanished edge carries at most one new edge.
 * The count of violations therefore never rises through this path.
 */

const edgeKey = (edge) => `${edge.from}>${edge.to}`;

function splitStem(file) {
  return file.replace(/\.[cm]?js$/, '');
}

function isSplitOf(newFile, oldFile) {
  const stem = splitStem(oldFile);
  return newFile !== oldFile && (newFile.startsWith(`${stem}-`) || newFile.startsWith(`${stem}/`));
}

/**
 * @param {Array<{from,to,fromLayer,toLayer}>} newEdges live violations the record does not hold
 * @param {Array<{from,to,fromLayer,toLayer}>} goneEdges recorded violations that are no longer live
 * @param {Record<string,string>} knownModules module -> ring, as recorded
 * @returns {{unexplained: object[], stillGone: object[], carried: Array<{from: object, to: object}>}}
 */
function pairCarriedViolations(newEdges, goneEdges, knownModules = {}) {
  const byKey = (a, b) => edgeKey(a).localeCompare(edgeKey(b));
  const available = [...goneEdges].sort(byKey);
  const carried = [];
  const unexplained = [];
  for (const edge of [...newEdges].sort(byKey)) {
    const index = Object.hasOwn(knownModules, edge.from) ? -1 : available.findIndex((old) => old.to === edge.to
      && old.fromLayer === edge.fromLayer
      && isSplitOf(edge.from, old.from));
    if (index === -1) {
      unexplained.push(edge);
    } else {
      carried.push({ from: available[index], to: edge });
      available.splice(index, 1);
    }
  }
  return { unexplained, stillGone: available, carried };
}

module.exports = { pairCarriedViolations, isSplitOf };
