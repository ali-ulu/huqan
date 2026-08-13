'use strict';

/**
 * The introspect() report computation, lifted out of kernel.js verbatim.
 *
 * Kernel keeps `introspect()` itself because the beforeIntrospect /
 * afterIntrospect plugin events and the _ok() envelope wrap belong to the
 * kernel's lifecycle; only the report body moved here. Everything this needs
 * (graph, already-computed contradictions/gaps/entropy, dream count) is
 * passed in, so this module has no import back into kernel.js and stays a
 * pure function of its arguments.
 */
function buildIntrospectReport({
  graph,
  workspaceId = 'default',
  contradictions = [],
  gaps = [],
  entropy = 0,
  dreamCount = 0,
}) {
  const allNodes = Object.values(graph.getNodes(workspaceId));
  const allEdges = allNodes.flatMap(n => graph.getEdges(n.id, workspaceId));

  // Temel istatistikler
  const nodeCount = allNodes.length;
  const edgeCount = allEdges.length;
  const typeEdges = allEdges.filter(e => e.relation === 'tür').length;
  const canEdges = allEdges.filter(e => e.relation === 'yapabilir').length;
  const ozellikEdges = allEdges.filter(e => e.relation === 'özellik').length;
  const benzerEdges = allEdges.filter(e => e.relation === 'benzer').length;
  const hipotezEdges = allEdges.filter(e => e.relation === 'hipotez').length;

  // Yalıtılmış düğümler
  const yalitilmis = allNodes.filter(n => {
    const out = graph.getEdges(n.id, workspaceId);
    const inn = graph.getInEdges(n.id, workspaceId);
    return out.length === 0 && inn.length === 0;
  }).map(n => n.id);

  const celiskiler = contradictions;
  const bosluklar = gaps;

  // Kenar ağırlık dağılımı
  const agirliklar = allEdges.map(e => e.weight || 0.5);
  const ortAgirlik = agirliklar.length > 0 ? agirliklar.reduce((s, w) => s + w, 0) / agirliklar.length : 0;
  const dusukAgirlik = agirliklar.filter(w => w < 0.3).length;

  // Öz-bilgi: graph kendisi hakkında ne biliyor?
  const selfNodes = ['axiom', 'kernel', 'dream', 'rüya', 'hipotez'];
  const selfBilgi = {};
  for (const n of selfNodes) {
    const node = graph.getNode(n, workspaceId);
    if (node) {
      const edges = graph.getEdges(n, workspaceId);
      selfBilgi[n] = { var: true, kenar: edges.length };
    } else {
      selfBilgi[n] = { var: false, kenar: 0 };
    }
  }

  // Rüya döngüsü
  const dreamCycle = dreamCount || 0;

  // Entropi (bilgi çeşitliliği)
  const entropi = entropy;

  // Meta-güven skoru
  let metaGuven = 0.5;
  if (nodeCount > 0) {
    metaGuven += Math.min(0.2, nodeCount * 0.001);
    metaGuven -= Math.min(0.3, celiskiler.length * 0.05);
    metaGuven += Math.min(0.1, ortAgirlik * 0.1);
    metaGuven -= Math.min(0.1, yalitilmis.length * 0.02);
    metaGuven = Math.max(0, Math.min(1, metaGuven));
  }

  // Zayıf noktalar
  const zayifNoktalar = [];
  if (yalitilmis.length > 0) zayifNoktalar.push(`${yalitilmis.length} isolated nodes`);
  if (celiskiler.length > 0) zayifNoktalar.push(`${celiskiler.length} contradictions`);
  if (dusukAgirlik > edgeCount * 0.3) zayifNoktalar.push(`${dusukAgirlik} low-confidence edges`);
  if (nodeCount < 5) zayifNoktalar.push('very little knowledge');

  // Güçlü noktalar
  const gucluNoktalar = [];
  if (nodeCount > 50) gucluNoktalar.push('a large knowledge graph');
  if (typeEdges > 10) gucluNoktalar.push('a strong type hierarchy');
  if (benzerEdges > 5) gucluNoktalar.push('an active similarity network');
  if (dreamCycle > 0) gucluNoktalar.push(`${dreamCycle} dream cycles completed`);

  return {
    bilgi: {
      dugum: nodeCount,
      kenar: edgeCount,
      tur: typeEdges,
      yapabilir: canEdges,
      ozellik: ozellikEdges,
      benzer: benzerEdges,
      hipotez: hipotezEdges,
      yalitilmis: yalitilmis.length,
      entropi: entropi.toFixed(3),
    },
    saglik: {
      metaGuven: parseFloat(metaGuven.toFixed(3)),
      celiski: celiskiler.length,
      bosluk: bosluklar.length,
      ortalamaAgirlik: parseFloat(ortAgirlik.toFixed(3)),
      dusukGuvenliKenar: dusukAgirlik,
    },
    ozBilgi: selfBilgi,
    zayifNoktalar,
    gucluNoktalar,
    dreamCycle,
  };
}

module.exports = { buildIntrospectReport };
