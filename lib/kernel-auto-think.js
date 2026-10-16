function runAutoThinkTick({
  dreamer,
  graph,
  commitBackgroundEdge,
  introspect,
  autoThinkLog,
  getDreamCount,
  setDreamCount,
}) {
  let dreamCount = getDreamCount();
  if (!dreamCount) dreamCount = 0;
  dreamCount++;
  setDreamCount(dreamCount);

  const isBilinclikTick = dreamCount > 0; // tüm tick'ler artık bilinçli

  // ADIM 1: Rüya gör + öğren (recursion)
  // FAZ2-PR3 (F-001-a): autonomous edge proposals route through
  // _commitBackgroundEdge so they receive synthetic provenance, admission
  // evaluation, and audit instead of writing directly to the graph.
  const hips = dreamer.dream();
  let eklenen = 0;
  let bekleyen = 0;
  if (hips.length > 0) {
    for (const h of hips.slice(0, 5)) {
      if (h.confidence > 0.25) {
        const existing = graph.hasAnyEdge(h.from, h.to);
        if (!existing && graph.getNode(h.from) && graph.getNode(h.to)) {
          const rel = h.type === 'zincir' ? 'benzer' : (h.type === 'benzerlik' ? 'benzer'
                    : h.relation === 'tür' ? 'tür'
                    : h.relation === 'yapabilir' ? 'yapabilir'
                    : h.relation === 'özellik' ? 'özellik'
                    : 'hipotez');
          const result = commitBackgroundEdge(h.from, h.to, rel, '_autoThinkTick', {
            provenanceExtra: {
              hypothesisType: h.type,
              hypothesisConfidence: h.confidence,
            },
          });
          if (result.decision === 'allow' && result.edge) eklenen++;
          else bekleyen++;
        }
      }
    }
  }

  // ADIM 2: İçgözlem (her tick'te değil, bilgi büyüdükçe)
  let celiskiSayisi = 0;
  let metaGuven = 0.5;
  if (isBilinclikTick && dreamCount % 3 === 0) {
    const durum = introspect().data;
    celiskiSayisi = durum.saglik.celiski;
    metaGuven = durum.saglik.metaGuven;

    // Zayıf noktaları tespit et
    if (celiskiSayisi > 5) {
      autoThinkLog(durum.zayifNoktalar.join('; '));
    }
  }

  // ADIM 3: Sürekli öğrenme dürtüsü (bilinç tikleri)
  if (eklenen > 0) {
    autoThinkLog(eklenen + ' new connections - ' + graph.nodeCount() + ' nodes total');
  } else if (dreamCount % 5 === 0) {
    // Boş rüya -> daha fazla girdi lazım
    autoThinkLog('empty dream, more input needed');
  }
}

module.exports = { runAutoThinkTick };
