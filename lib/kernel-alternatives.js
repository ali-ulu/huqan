function runAlternatives(normalizeWord, graph, ok, subject, maxPaths = 3, workspaceId = 'default') {
  const normalized = normalizeWord(subject);
  const node = graph.getNode(normalized, workspaceId);
  if (!node) {
    return ok('alternatives', { subject: normalized, answer: 'Bilmiyorum', paths: [] }, []);
  }

  // 1. Doğrudan kenarlardan alternatif grupları oluştur
  const edges = graph.getEdges(normalized, workspaceId);
  const groups = { 'tür': [], yapabilir: [], 'özellik': [], benzer: [], hipotez: [] };
  for (const e of edges) {
    const g = groups[e.relation];
    if (g) g.push(e.to);
  }

  // 2. En yüksek güvenli hedefleri seç, her gruptan bir tane al
  const paths = [];
  const usedNodes = new Set([normalized]);

  // İlişki önceliği: tür > yapabilir > özellik > benzer > hipotez
  const relOrder = ['tür', 'yapabilir', 'özellik', 'benzer', 'hipotez'];

  for (const rel of relOrder) {
    if (paths.length >= maxPaths) break;
    const targets = groups[rel] || [];
    if (targets.length === 0) continue;

    // Güvene göre sırala (yüksekten düşe)
    const sorted = targets
      .map(t => ({ target: t, weight: edges.find(e => e.to === t && e.relation === rel)?.weight || 0.5 }))
      .sort((a, b) => b.weight - a.weight);

    const best = sorted[0];
    if (usedNodes.has(best.target)) continue;

    const subEdges = graph.getEdges(best.target, workspaceId).filter(e => !usedNodes.has(e.to));
    const chain = subEdges.slice(0, 2).map(e => ({ node: e.to, rel: e.relation }));
    paths.push({
      type: rel,
      from: normalized,
      to: best.target,
      chain,
      confidence: best.weight,
    });
    usedNodes.add(best.target);
  }

  // 3. Alternatif çözüm olarak değerlendir
  let answer = normalized + ': alternative paths:\n';
  for (const p of paths) {
    answer += `  [${p.type}] ${p.from} → ${p.to}`;
    if (p.chain.length > 0) {
      answer += ` → ${p.chain.map(c => c.node + '(' + c.rel + ')').join(', ')}`;
    }
    answer += ` (confidence: ${p.confidence.toFixed(2)})\n`;
  }
  if (paths.length === 0) answer = 'Bilmiyorum';

  const evidence = paths.map(p => ({
    kind: 'alternative_path',
    text: `${p.from} --[${p.type}]--> ${p.to}`,
    confidence: p.confidence,
    nodes: [p.from, p.to],
    edges: [{ from: p.from, to: p.to, relation: p.type }],
  }));

  return ok('alternatives', { subject: normalized, answer, paths }, evidence);
}

module.exports = { runAlternatives };
