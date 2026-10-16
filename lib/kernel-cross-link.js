'use strict';

/**
 * FAZ2-PR3 (F-001-d): Derive "benzer" (similarity) edges from shared tags.
 *
 * Two entry modes:
 *  - Parent-allowed (context.parentAdmissionAllowed === true):
 *      Invoked from the main learn path AFTER user admission allowed the
 *      parent write.  Derived "benzer" edges inherit parent provenance and
 *      are audited as derived writes; no background admission round-trip
 *      so the derived chain does not deadlock on review-by-default.  This
 *      mirrors the parent admission decision rather than introducing a
 *      separate background gate for a write the user already authorized.
 *  - Background (no context):
 *      Invoked externally (e.g. inference/maintenance).  Routed through
 *      _commitBackgroundEdge so the synthetic provenance is admission-gated.
 *      Default decision is 'review' → no canonical write.
 *
 * Either path produces an audit event so the attempt is observable.
 *
 * Moved verbatim from Kernel._crossLink (#2127).  Collaborators arrive as
 * an explicit object so this module never reaches into kernel internals.
 */
function runCrossLink(collaborators, subject, object, relation, workspaceId = 'default', context = {}) {
  const { graph, appendAuditEvent, admissionReceiptDetails, commitBackgroundEdge } = collaborators;
  const subjNode = graph.getNode(subject, workspaceId);
  const objNode = graph.getNode(object, workspaceId);
  if (!subjNode || !objNode) return { written: 0, audits: 0, skipped: 0 };

  const parentAllowed = Boolean(context && context.parentAdmissionAllowed);
  const parentProvenance = context && context.parentProvenance ? context.parentProvenance : null;
  const parentAdmission = context && context.parentAdmission ? context.parentAdmission : null;

  let written = 0;
  let audits = 0;
  let skipped = 0;

  for (const tag of Object.keys(subjNode.vector)) {
    if (tag !== object && graph.getNode(tag, workspaceId) && objNode.vector[tag]) {
      const existing = graph.getEdge(subject, object, 'benzer', workspaceId);
      if (!existing) {
        if (parentAllowed) {
          // Parent learn admission already permitted the canonical write
          // that triggered this derivation.  Carry parent provenance + audit.
          const edgeOptions = { workspaceId };
          if (parentProvenance) edgeOptions.provenance = parentProvenance;
          edgeOptions.source = (context && context.derivedSource) || 'cross-link';
          const edge = graph.addEdge(subject, object, 'benzer', edgeOptions);
          if (edge) {
            written++;
            const audit = appendAuditEvent({
              eventType: 'LEARN',
              targetType: 'derived_edge',
              targetId: `${edge.from}|${edge.relation}|${edge.to}`,
              details: {
                derivation: 'cross_link',
                triggerSubject: subject,
                triggerObject: object,
                triggerRelation: relation,
                via: tag,
                ...admissionReceiptDetails(parentAdmission),
              },
            }, parentProvenance, workspaceId);
            if (audit) audits++;
          }
        } else {
          // Background invocation — route through admission gate.
          const result = commitBackgroundEdge(subject, object, 'benzer', '_crossLink', {
            workspaceId,
            edgeOptions: { source: 'cross-link' },
            provenanceExtra: { derivation: 'cross_link', via: tag },
          });
          if (result.audit) audits++;
          if (result.decision === 'allow' && result.edge) written++;
          else skipped++;
        }
      }
    }
  }

  return { written, audits, skipped };
}

module.exports = { runCrossLink };
