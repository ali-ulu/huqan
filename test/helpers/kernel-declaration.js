'use strict';

/**
 * Helpers for asserting on kernel.d.ts / kernel.v2.d.ts text.
 *
 * The audit-seam contracts need to say "the Kernel class does not expose a
 * public appendAuditEvent". Matching that as a bare substring over the whole
 * class body is not the same claim: the body also declares `graph: { ... }`,
 * and `kernel.graph.appendAuditEvent` is a real, deliberately-used runtime
 * method (graph.js defines it; agent.v3.js calls it). Once kernel.d.ts was
 * widened to describe the graph surface honestly, the substring match started
 * firing on that nested declaration rather than on anything the Kernel itself
 * exposes.
 *
 * These helpers let a test target one object's surface rather than the whole
 * file, so "Kernel has no public audit append" and "types describe the graph
 * accurately" can both hold.
 */

/**
 * Locates a `name: { ... }` member and returns its span, matching braces so
 * nested object types inside the member do not end it early.
 *
 * @returns {{start: number, end: number, body: string}|null}
 */
function findNestedMember(source, memberName) {
  const text = String(source || '');
  const header = new RegExp(`\\b${memberName}\\s*:\\s*\\{`);
  const match = header.exec(text);
  if (!match) return null;

  const open = text.indexOf('{', match.index);
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const char = text[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return { start: match.index, end: i + 1, body: text.slice(open, i + 1) };
      }
    }
  }
  return null;
}

/** The body of a `name: { ... }` member, or '' when it is not declared. */
function nestedMemberBody(source, memberName) {
  const found = findNestedMember(source, memberName);
  return found ? found.body : '';
}

/**
 * `source` with the `name: { ... }` member removed, leaving the declaring
 * object's own surface. Used to assert on what a class exposes directly,
 * rather than on what its nested members expose.
 */
function withoutNestedMember(source, memberName) {
  const text = String(source || '');
  const found = findNestedMember(text, memberName);
  return found ? text.slice(0, found.start) + text.slice(found.end) : text;
}

/** The `declare class Kernel` body onwards, or '' when absent. */
function kernelClassBody(declaration) {
  const text = String(declaration || '');
  const start = text.indexOf('declare class Kernel');
  return start === -1 ? '' : text.slice(start);
}

module.exports = {
  findNestedMember,
  nestedMemberBody,
  withoutNestedMember,
  kernelClassBody,
};
