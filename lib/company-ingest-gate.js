'use strict';

/**
 * The gate chain a company's own data has to pass before it becomes memory.
 *
 * Manual company ingest is typed by a person who can see what they are typing.
 * API ingest is not: it pulls whatever the other system holds -- a wiki page
 * with an access token pasted into it, a ticket carrying a customer's ID
 * number -- and the person who authorised the connection never reads it. That
 * is the difference that makes this module necessary rather than decorative.
 *
 * Two gates, in this order, on the text itself:
 *
 *   AB9 egress         PII out, and credential-shaped values out
 *   AB7 secret scrub   backstop over what egress returned
 *
 * The order is not arbitrary and was chosen by measurement. Running the secret
 * scrub first replaced the whole field with [REDACTED], after which the egress
 * gate had nothing left to inspect and reported piiDetected: false on a document
 * that contained a national ID number. The record would have said no PII was
 * present. Detecting on the raw text first is what makes the reported flags
 * describe the document rather than describe the previous gate's output.
 *
 * What matters at least as much is that the *scrubbed* text is what continues. A chain that runs the gates and then learns the original is not a
 * chain, and reads identically in a call-counting test -- which is why the
 * accompanying tests assert the raw value is absent from what was stored rather
 * than asserting these functions were called.
 */

const { scrubSecrets } = require('./secret-scrub-gate');
const { evaluateEgress } = require('./data-egress-gate');

const COMPANY_INGEST_GATE_VERSION = 'company-ingest-v0.1.0';

/**
 * @param {string} text raw content as it arrived from the external system
 * @returns {{text: string, secretDetected: boolean, piiDetected: boolean,
 *            piiTypes: string[], gateVersions: object}}
 *   `text` is what callers must use. Reaching past it to the input is the
 *   failure this module exists to prevent.
 */
function gateCompanyIngest(text) {
  const raw = typeof text === 'string' ? text : '';

  // Both gates operate on payload objects, so the text travels as one field and
  // comes back out of the same field. Wrapping rather than calling a string API
  // keeps this on the gates' real surface instead of a parallel one.
  const afterEgress = evaluateEgress({ text: raw });
  const afterSecrets = scrubSecrets(afterEgress.scrubbed);

  const scrubbedText = afterSecrets.scrubbed && typeof afterSecrets.scrubbed.text === 'string'
    ? afterSecrets.scrubbed.text
    : '';

  return {
    text: scrubbedText,
    secretDetected: Boolean(afterEgress.secretDetected || afterSecrets.secretDetected),
    piiDetected: Boolean(afterEgress.piiDetected),
    piiTypes: afterEgress.piiTypes || [],
    gateVersions: {
      egress: afterEgress.gateVersion,
      secretScrub: afterSecrets.gateVersion,
      companyIngest: COMPANY_INGEST_GATE_VERSION,
    },
  };
}

module.exports = { gateCompanyIngest, COMPANY_INGEST_GATE_VERSION };
