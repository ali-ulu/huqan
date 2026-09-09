'use strict';

function selectBudgetedTools({ rankedTools = [], sequence = [], maxSteps, budget }) {
  const selected = [];
  const used = new Set();
  let estimatedBudget = 0;

  for (const preferredName of sequence) {
    if (selected.length >= maxSteps) break;
    const match = rankedTools.find(item => item.tool.name === preferredName);
    if (!match || used.has(match.tool.name)) continue;
    if (estimatedBudget + match.tool.cost > budget) continue;
    selected.push(match);
    used.add(match.tool.name);
    estimatedBudget += match.tool.cost;
  }

  for (const item of rankedTools) {
    if (selected.length >= maxSteps) break;
    if (used.has(item.tool.name)) continue;
    if (estimatedBudget + item.tool.cost > budget) continue;
    selected.push(item);
    used.add(item.tool.name);
    estimatedBudget += item.tool.cost;
  }

  if (!selected.length && rankedTools.length && rankedTools[0].tool.cost <= budget) {
    selected.push(rankedTools[0]);
  }

  return selected;
}

module.exports = { selectBudgetedTools };
