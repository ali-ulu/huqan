'use strict';

// H-06: kernel-öğrenme yolunun kenar seçeneklerini kuran tek yer.
//
// Aynı kanıt metni tekrar learn edilince graph katmanındaki +0.1 ağırlık
// artırımı şişmeye yol açıyordu (6x learn: 0.5 -> ~1.0, evidence tek
// eleman). Daraltma yalnız bu yoldadır: `suppressWeightBumpOnReaffirm`
// bayrağı set edilir, graph-edge-write.js artımı yalnızca gerçekten yeni
// kanıt metni yoksa bastırır ve `confidence_history`'ye `reaffirmed`
// kaydı düşer. Doğrudan graph.addEdge çağrıları bayrağı taşımadığı için
// eski davranışını korur.
function buildLearnEdgeOptions(base = {}, meta = {}, text = '') {
  const options = {
    ...base,
    evidence: Array.isArray(base.evidence) ? base.evidence : [text],
    suppressWeightBumpOnReaffirm: true,
  };
  if (meta.sourceRef) options.sourceRef = meta.sourceRef;
  if (meta.sessionId) options.sessionId = meta.sessionId;
  if (meta.sourceType) options.sourceType = meta.sourceType;
  if (meta.evidenceType) options.evidenceType = meta.evidenceType;
  if (meta.companyMode) options.companyMode = true;
  return options;
}

module.exports = { buildLearnEdgeOptions };
