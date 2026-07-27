'use strict';

function runLearnUseCase(kernel, text, opts = {}, dependencies = {}) {
  return executeLearn.call(kernel, text, opts, true, dependencies);
}

function executeLearn(text, opts = {}, skipBeforeLearn = false, dependencies = {}) {
  const { normalizeWorkspaceId, ProvenanceError } = dependencies;
  if (!skipBeforeLearn) {
    const ev = this._runBeforeLearn(text, opts);
    text = ev.text;
    opts = ev.opts || opts;
  }
  const fallbackWorkspaceId = normalizeWorkspaceId(opts.workspaceId || opts.provenance?.workspaceId);
  const hasProvenanceInput =
    Object.prototype.hasOwnProperty.call(opts, 'provenance') ||
    opts.sourceType ||
    opts.sourceRef ||
    opts.sourceTitle ||
    opts.actor ||
    opts.timestamp ||
    opts.workspaceId;
  let provenanceBundle;
  try {
    provenanceBundle = hasProvenanceInput
      ? this._normalizeProvenanceInput(opts.provenance || {}, opts)
      : { provenance: { provenanceId: `auto-${Date.now()}-${Math.random().toString(36).slice(2,8)}`, timestamp: new Date().toISOString(), source: 'learn', actor: 'kernel' }, warnings: [] };
  } catch (error) {
    if (error instanceof ProvenanceError || error.code === 'PROVENANCE_REQUIRED') {
      this._appendAuditEvent({
        eventType: 'REJECT',
        targetType: 'learn',
        targetId: text,
        details: {
          reason: error.code || 'PROVENANCE_REQUIRED',
          message: error.message,
          text,
        },
      }, opts.provenance && typeof opts.provenance === 'object' ? opts.provenance : null, fallbackWorkspaceId);
    }
    throw error;
  }
  const provenance = provenanceBundle.provenance;
  const provenanceWarnings = provenanceBundle.warnings;
  const workspaceId = normalizeWorkspaceId(provenance?.workspaceId || opts.workspaceId || fallbackWorkspaceId);
  const admission = this._evaluateLearnAdmission(text, opts, provenance, workspaceId);

  if (admission && admission.outcome !== 'allow') {
    this._appendAuditEvent({
      eventType: admission.outcome === 'reject' ? 'REJECT' : 'REVIEW',
      targetType: 'learn',
      targetId: text,
      details: {
        text,
        reason: admission.reason,
        admissionOutcome: admission.outcome,
        approvalStatus: admission.approvalStatus,
        ...this._admissionReceiptDetails(admission),
      },
    }, provenance, workspaceId);
    return this._ok('learn', {
      learned: 0,
      skipped: 1,
      conflicts: [],
      alternatives: [],
      provenanceWarnings,
      admission,
    }, [], {
      provenance: provenance || null,
      provenanceWarnings,
      trustPolicyVersion: provenance ? provenance.trustPolicyVersion : undefined,
      admission,
    });
  }

  if (this.strictProvenance && !hasProvenanceInput) {
    this._appendAuditEvent({
      eventType: 'REJECT',
      targetType: 'learn',
      targetId: text,
      details: {
        reason: 'PROVENANCE_REQUIRED',
        message: 'provenance is required when strictProvenance is true',
        text,
      },
    }, opts.provenance && typeof opts.provenance === 'object' ? opts.provenance : null, workspaceId);
    throw new ProvenanceError();
  }

  const parsed = this.extractFacts(text, this.graph.getNodes(workspaceId));
  if (!parsed) return this._ok('learn', {
    learned: 0,
    skipped: 1,
    conflicts: [],
    admission: admission || null,
  }, [], admission ? { admission } : {});

  // KAL?TE KONTROLÃœ: çelişki ve alternatif tespiti
  const conflicts = [];
  const alternatives = [];
  let learned = 0;
  const evidence = [];
  const metadata = this._resolveLearnMetadata(opts);

  for (const { subject, predicate } of parsed) {
    if (typeof subject !== 'string' || !subject.trim() || this.isStopWord(subject)) continue;
    if (typeof predicate !== 'string' || !predicate.trim()) continue;

    const rel = this._parsePredicate(predicate);
    if (!rel || typeof rel !== 'object') continue;
    const { object, relation } = rel;
    if (typeof object !== 'string' || !object.trim() || typeof relation !== 'string' || !relation.trim()) continue;
    if (this.isStopWord(object)) continue;

    const isCopulaNegation = relation === 'değil' && /(?:^|\s)(?:değildir|degildir)\s*$/i.test(predicate.trim());
    const negatedObject = isCopulaNegation ? `${object} [değil]` : object;

      // AYNI ?zne-ili?ki i?in mevcut nesneleri bul
      const existingEdges = this.graph.getEdges(subject, workspaceId).filter(e => e.relation === relation);
      const existingTargets = existingEdges.map(e => e.to);

      // Ã‡EL?ÅK? KONTROLÃœ
      // tür: farkl? anlam ta??yan iki tür ? çelişki
      // değil: ayn? nesne i?in "tür" varsa ? çelişki
      // kistlama (sadece): ayn? ?zne i?in ba?ka yapabilir varsa ? çelişki
      let celiskiBulundu = false;

      if (relation === 'tür') {
        for (const existing of existingTargets) {
          if (existing !== object) {
            const benzerlik = this.contextSimilarity(object, existing, subject);
            if (benzerlik < 0.15) {
              conflicts.push({
                type: 'alternative',
                subject,
                relation: 'tür',
                current: object,
                existing,
                confidence: parseFloat(benzerlik.toFixed(3)),
              });
              celiskiBulundu = true;
            }
          }
        }
      }

      if (relation === 'değil') {
        const turEdges = this.graph.getEdges(subject, workspaceId).filter(e => e.relation === 'tür');
        for (const tur of turEdges) {
          if (tur.to === object) {
            const onceki = tur.weight;
            const oncekiTarget = tur.to;
            tur.weight = 0.2;
            tur.celiski = 'downgraded';
            if (isCopulaNegation) {
              tur.to = negatedObject;
              tur.relation = 'değil';
              tur.negated = true;
              tur.negatedObject = object;
            }
            conflicts.push({
              type: 'negation',
              subject,
              relation: 'değil',
              current: object,
              existing: oncekiTarget,
              message: `"${subject}" "${object} değildir" deniyor (önceden tür:${onceki}) → tür weight düşürüldü`,
              confidence: 0,
            });
            celiskiBulundu = true;
          }
        }
      }

      // KISITLAMA: "sadece x yapar" ? ba?ka yapabilir varsa çelişki
      if (rel.kistlama && relation === 'yapabilir') {
        const digerYapabilir = existingEdges.filter(e => e.relation === 'yapabilir' && e.to !== object);
        for (const dg of digerYapabilir) {
          conflicts.push({
            type: 'restriction',
            subject,
            relation: 'yapabilir',
            current: object,
            existing: dg.to,
            message: `"${subject}" sadece "${object}" yapabilir deniyor ama "${dg.to}" da yapabiliyor`,
            confidence: 0,
          });
          celiskiBulundu = true;
        }
      }

      // ALTERNAT?F: ayn? kavram?n farkl? ifadelerini tespit et
      if (existingTargets.length > 0 && !existingTargets.includes(object)) {
        alternatives.push({
          subject,
          relation,
          current: object,
          existing: existingTargets,
        });
      }

      // Ã–ÄRENME: d?k g?venli alternatifleri de ekle (çelişkiyi ?nlemek i?in farkl? ili?kiyle)
      if (provenance) {
        this.graph.addNode(subject, subject, provenance, { workspaceId });
        this.graph.addNode(object, object, provenance, { workspaceId });
        if (isCopulaNegation) this.graph.addNode(negatedObject, negatedObject, provenance, { workspaceId });
      } else {
        this.graph.addNode(subject, subject, null, { workspaceId });
        this.graph.addNode(object, object, null, { workspaceId });
        if (isCopulaNegation) this.graph.addNode(negatedObject, negatedObject, null, { workspaceId });
      }

      if (celiskiBulundu && (relation === 'tür')) {
        // tür çelişkisi ? benzer olarak kaydet
        const edgeOptions = this._learnEdgeOptions({ source: 'alt', weight: 0.15, evidence: [text] }, metadata, text);
        if (provenance) edgeOptions.provenance = provenance;
        edgeOptions.workspaceId = workspaceId;
        const edge = this.graph.addEdge(
          subject,
          object,
          'benzer',
          edgeOptions
        );
        if (edge) { learned++; evidence.push(this._edgeEvidence(edge)); }
        if (edge) {
          this._appendAuditEvent({
            eventType: 'LEARN',
            targetType: 'edge',
            targetId: `${edge.from}|${edge.relation}|${edge.to}`,
            details: {
              text,
              subject,
              relation: edge.relation,
              object: edge.to,
              conflict: true,
              ...this._admissionReceiptDetails(admission),
            },
          }, provenance, workspaceId);
        }
              } else if (relation === 'değil') {
        const edgeOptions = this._learnEdgeOptions({ source: 'learn', evidence: [text] }, metadata, text);
        if (provenance) edgeOptions.provenance = provenance;
        edgeOptions.workspaceId = workspaceId;
        const edge = this.graph.addEdge(
          subject,
          isCopulaNegation ? negatedObject : object,
          relation,
          edgeOptions
        );
        if (edge) { learned++; evidence.push(this._edgeEvidence(edge)); }
        if (edge) {
          const storedObject = isCopulaNegation ? negatedObject : object;
          const hadExisting = existingEdges.some(e => e.to === storedObject && e.relation === relation);
          this._appendAuditEvent({
            eventType: hadExisting ? 'REAFFIRMED' : 'LEARN',
            targetType: 'edge',
            targetId: `${edge.from}|${edge.relation}|${edge.to}`,
            details: {
              text,
              subject,
              relation,
              object: storedObject,
              originalObject: object,
              conflict: celiskiBulundu,
              reaffirmed: hadExisting,
              ...this._admissionReceiptDetails(admission),
            },
          }, provenance, workspaceId);
        }
      } else if (celiskiBulundu) {
        // kistlama ? d?k weight ile kaydet
        const edgeOptions = this._learnEdgeOptions({ source: 'learn', weight: 0.2, evidence: [text] }, metadata, text);
        if (provenance) edgeOptions.provenance = provenance;
        edgeOptions.workspaceId = workspaceId;
        if (['CAUSES', 'PREVENTS', 'DEPENDS_ON', 'ENABLES'].includes(relation)) edgeOptions.strength = edgeOptions.strength ?? 0.8;
        const edge = this.graph.addEdge(
          subject,
          object,
          relation,
          edgeOptions
        );
        if (rel.kistlama && edge) edge.kistlama = true;
        if (edge) { learned++; evidence.push(this._edgeEvidence(edge)); }
        if (edge) {
          const hadExisting = existingEdges.some(e => e.to === object && e.relation === relation);
          this._appendAuditEvent({
            eventType: hadExisting ? 'REAFFIRMED' : 'LEARN',
            targetType: 'edge',
            targetId: `${edge.from}|${edge.relation}|${edge.to}`,
            details: {
              text,
              subject,
              relation,
              object,
              conflict: true,
              reaffirmed: hadExisting,
              ...this._admissionReceiptDetails(admission),
            },
          }, provenance, workspaceId);
        }
      } else {
        // Normal ?ÄŸrenme
        const edgeOptions = this._learnEdgeOptions({ source: 'learn', evidence: [text] }, metadata, text);
        if (provenance) edgeOptions.provenance = provenance;
        edgeOptions.workspaceId = workspaceId;
        if (['CAUSES', 'PREVENTS', 'DEPENDS_ON', 'ENABLES'].includes(relation)) edgeOptions.strength = edgeOptions.strength ?? 0.8;
        const hadExisting = existingEdges.some(e => e.to === object && e.relation === relation);
        const edge = this.graph.addEdge(
          subject,
          object,
          relation,
          edgeOptions
        );
        this.graph.addTag(subject, object, 0.3, workspaceId);
        // FAZ2-PR3: derived cross-link writes inherit parent learn admission +
        // provenance.  This is NOT a background bypass — the parent admission
        // already evaluated this user-initiated write.
        this._crossLink(subject, object, relation, workspaceId, {
          parentAdmissionAllowed: true,
          parentProvenance: provenance,
          derivedSource: 'learn',
        });
        learned++;
        if (edge) evidence.push(this._edgeEvidence(edge));
        if (edge) {
          this._appendAuditEvent({
            eventType: hadExisting ? 'REAFFIRMED' : 'LEARN',
            targetType: 'edge',
            targetId: `${edge.from}|${edge.relation}|${edge.to}`,
            details: {
              text,
              subject,
              relation,
              object,
              reaffirmed: hadExisting,
              ...this._admissionReceiptDetails(admission),
            },
          }, provenance, workspaceId);
        }
      }
    }

  const afterCommitEffects = Array.isArray(opts._postCommitEffects) ? opts._postCommitEffects : null;
  const emitAfterLearn = () => this.plugins.emit('afterLearn', { text, conflicts, alternatives, opts: { ...metadata, workspaceId } });
  const notifyRust = () => {
    if (this._rust) {
      this._rust.learn(text).catch((e) => { console.error("[Kernel] Rust learn hatası:", e?.message || e); });
    }
  };
  if (afterCommitEffects) {
    afterCommitEffects.push(emitAfterLearn, notifyRust);
  } else {
    emitAfterLearn();
    notifyRust();
  }

  if (learned > 0) {
    if (!opts._durableMutationTransaction) {
      try { this.graph.save(); } catch (e) { console.error("[Kernel] Graph save hatası:", e.message); }
    }
    if (typeof setImmediate !== 'undefined') setImmediate(() => this._autoMaintain());
  }

  return this._ok('learn', {
    learned,
    skipped: parsed.length - learned,
    conflicts,
    alternatives,
    provenanceWarnings,
    admission: admission || null,
  }, evidence, {
    provenance: provenance || null,
    provenanceWarnings,
    trustPolicyVersion: provenance ? provenance.trustPolicyVersion : undefined,
    admission: admission || null,
  });
}

module.exports = { runLearnUseCase };
