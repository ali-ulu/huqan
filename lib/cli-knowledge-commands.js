const fs = require('fs');
const { shellQuote, resolveCliReadPath, commandFailure } = require('./cli-helpers');

// CLI command handlers (cli.js registry): teach, ask, verify, reason, compare,
// load a document, dream, persist and the auto-think stop.

function teachCommand(cli, args, opts, command) {
  const result = cli.kernel.learn(args, { sourceType: 'cli', sourceRef: 'cli:öğret', actor: 'cli-user' });
  const subject = String(args || '').toLowerCase().split(/\s+/)[0];
  if (result && result.ok === false) {
    const reason = (result.error && result.error.message) || 'bilinmeyen hata';
    return commandFailure(`Ogretici basarisiz: ${reason}`, opts);
  }
  // learn() returns ok:true even when nothing was written -- the admission gate
  // queues a review (or rejects) instead of throwing. Report the real outcome
  // rather than claiming the fact was learned.
  const admission = result && result.data && result.data.admission;
  if (admission && admission.outcome && admission.outcome !== 'allow') {
    return admission.outcome === 'reject'
      ? `Reddedildi: "${subject}" ogretilemedi (${admission.reason || 'kural'}).`
      : `Onay bekliyor: "${subject}" ogretilemedi; inceleme kuyruguna alindi (${admission.reason || 'review'}).`;
  }
  if (result && result.data && result.data.learned === 0) {
    return `"${subject}" icin yeni bilgi ogrenilmedi (0 fact).`;
  }
  return `OK "${subject}" öğrendim.`;
}

function verifyCommand(cli, args, opts, command) {
  const result = cli.kernel.verify(args);
  const data = result.data || {};
  const evidence = Array.isArray(result.evidence) ? result.evidence : [];
  let out = `Verify: ${data.status || 'unknown'} (confidence: ${typeof data.confidence === 'number' ? data.confidence.toFixed(2) : 'n/a'})`;
  if (evidence.length > 0 && evidence[0] && evidence[0].text) out += `\nEvidence: ${evidence[0].text}`;
  if (data.grounding === 'taught_only') out += '\nGrounding: taught only - asserted to HUQAN through learn, not checked against an independent source.';
  return out;
}

function askCommand(cli, args, opts, command) {
  const result = cli.kernel.ask(args);
  const answer = result.data.answer;
  return answer === 'Bilmiyorum' ? `X ${answer}` : `Cevap: ${answer}`;
}

function reasonCommand(cli, args, opts, command) {
  const result = cli.kernel.reason(args);
  const answer = result.data.answer;
  return answer === 'Bilmiyorum' ? `X ${answer}` : `Neden: ${answer}`;
}

function compareCommand(cli, args, opts, command) {
  // Defaults, the way _evaluateCliGate()'s 'huqan.compare' branch already
  // writes it. normalizeCompareArgs() returns the text unchanged when it
  // finds neither '|' nor ' vs ', so a single-term `compare: elma` reached
  // `right.trim()` on undefined and threw a raw stack trace at the user
  // (#1029).
  const [left = '', right = ''] = String(args || '').split('|');
  if (!left.trim() || !right.trim()) {
    return commandFailure('Kullanim: compare: <a>|<b>', opts);
  }
  const result = cli.kernel.compare(left.trim(), right.trim());
  const answer = result.data.answer;
  return answer === 'Bilmiyorum' ? `X ${answer}` : `Karsilastirma: ${answer}`;
}

function llmAskCommand(cli, args, opts, command) {
  const axiomResult = cli.kernel.ask(args);
  const verifyResult = cli.kernel.verify(args);
  const verify = verifyResult.data || {};
  // The verify branch above guards these with `typeof === 'number'`; this
  // one did not, so a non-numeric confidence or risk score crashed the
  // same way (#1029).
  const confidenceText = typeof verify.confidence === 'number' ? verify.confidence.toFixed(2) : 'n/a';
  let out = `AXIOM dogrulamasi: ${verify.status || 'unknown'} (guven: ${confidenceText})`;
  if (axiomResult.data.answer !== 'Bilmiyorum') out += `\nAXIOM: ${axiomResult.data.answer}`;
  const evidence = Array.isArray(verifyResult.evidence) ? verifyResult.evidence : [];
  if (evidence.length > 0 && evidence[0] && evidence[0].text) out += `\nKanit: ${evidence[0].text}`;
  if (verify.risk && verify.risk.manipulation) {
    const labels = Array.isArray(verify.risk.labels) && verify.risk.labels.length > 0 ? verify.risk.labels.join(', ') : 'manipulation';
    const scoreText = typeof verify.risk.score === 'number' ? verify.risk.score.toFixed(2) : 'n/a';
    out += `\nRisk: ${labels} (skor: ${scoreText})`;
  }
  out += `\nLLM yaniti icin: ollama run ${shellQuote(cli.llm.model)} ${shellQuote(args)}`;
  return out;
}

function loadDocumentCommand(cli, args, opts, command) {
  try {
    const filePath = resolveCliReadPath(args);
    const text = fs.readFileSync(filePath, 'utf8');
    const count = cli.kernel.learnDocument(text, {
      sourceType: 'cli',
      sourceRef: `cli:yükle:${args}`,
      actor: 'cli-user',
    });
    return `Learned ${count} fact(s) from "${args}".`;
  } catch (error) {
    return commandFailure(`Could not read file: ${error.message}`, opts);
  }
}

// Not every hypothesis carries `from`/`to`: the çelişki (contradiction) shape
// carries `node` + `targets[]` instead, so reading only from/to printed
// `undefined -> undefined` for a real finding (#3906).
function formatDreamHypothesis(item) {
  const confidence = typeof item.confidence === 'number' ? item.confidence.toFixed(2) : 'n/a';
  if (item.from === undefined && item.to === undefined && Array.isArray(item.targets)) {
    const targets = item.targets.map(value => String(value)).join(', ');
    return `  ${item.node} --[${item.type}]--> ${targets} (guven: ${confidence})`;
  }
  return `  ${item.from} -> ${item.to} (${item.type}, guven: ${confidence})`;
}

function dreamCommand(cli, args, opts, command) {
  const hypotheses = cli.dream.dream();
  if (hypotheses.length === 0) return 'I could not produce a hypothesis; I need more information.';
  const lines = hypotheses.map(formatDreamHypothesis);
  return `${hypotheses.length} hipotez:\n${lines.join('\n')}`;
}

function persistCommand(cli, args, opts, command) {
  cli.kernel.persist();
  return `Memory saved.${cli.commitCliMutation('kaydet')}`;
}

function thinkCommand(cli, args, opts, command) {
  if (args === 'dur') {
    cli.kernel.stopAutoThink();
    return 'Dusunmeyi durdurdum.';
  }
  return cli.formatCliGateMessage(command, {
    decision: 'block',
    reason: 'cli_automation_unavailable',
  });
}

module.exports = {
  teachCommand,
  verifyCommand,
  askCommand,
  reasonCommand,
  compareCommand,
  llmAskCommand,
  loadDocumentCommand,
  dreamCommand,
  persistCommand,
  thinkCommand,
};
