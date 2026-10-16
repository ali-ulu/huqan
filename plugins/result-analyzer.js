const { adjustedConfidence } = require('../evidence-ranker');

function normalizeInput(input) {
  if (typeof input === 'string') return input.trim();
  if (input && typeof input.result === 'string') return input.result.trim();
  if (input && typeof input.observation === 'string') return input.observation.trim();
  if (input && typeof input.text === 'string') return input.text.trim();
  return '';
}

// #1307 / #1325: a plain substring-anywhere test let positive stems match
// inside a negated word (invalid -> valid, unsupported -> support), and an
// unqualified prefix match (an earlier fix for #1307) let "pass" match
// inside "passive". Each entry here is a literal word plus, where the word
// has common inflections actually seen in experiment write-ups, an explicit
// suffix alternation -- matched with \b on both sides so "passive"/
// "workshop"/"bypass" cannot match "pass"/"work"/"pass". Includes the
// Turkish stems #1325 asked for, since result text is not English-only.
const REJECT_WORDS = [
  'reject(?:s|ed|ing)?', 'fail(?:s|ed|ing)?', 'negative', 'false',
  'den(?:y|ies|ied)', 'broken', 'invalid',
  'gecersiz', 'geçersiz', 'basarisiz', 'başarısız', 'reddedildi',
  'dogrulanmadi', 'doğrulanmadı',
];
const SUPPORT_WORDS = [
  'support(?:s|ed|ing)?', 'confirm(?:s|ed|ing)?', 'positive',
  'pass(?:es|ed|ing)?', 'true', 'works?', 'valid',
  'destekliyor', 'dogrulandi', 'doğrulandı', 'basarili', 'başarılı',
  'gecerli', 'geçerli',
];
const REJECT_PATTERN = new RegExp(`\\b(?:${REJECT_WORDS.join('|')})\\b`);
const SUPPORT_PATTERN = new RegExp(`\\b(?:${SUPPORT_WORDS.join('|')})\\b`);

function classifySignal(text) {
  const normalized = String(text || '').toLowerCase();
  const hasReject = REJECT_PATTERN.test(normalized);
  const hasSupport = SUPPORT_PATTERN.test(normalized);
  // Both present (e.g. "does not support the hypothesis; reject it") is
  // genuinely ambiguous -- falling through to 'mixed' routes it to a human
  // via experimentPlanner/'refine' instead of silently picking a side.
  if (hasReject && hasSupport) return 'mixed';
  if (hasReject) return 'reject';
  if (hasSupport) return 'support';
  return 'mixed';
}

function createResultAnalyzerPlugin() {
  return {
    name: 'result-analyzer',
    version: '0.1.0',
    capabilities: [
      {
        name: 'resultAnalyzer',
        command: 'analyze-result',
        description: 'Turns an experiment result into a minimal evidence summary.',
      },
    ],

    async run(kernel, input, opts = {}) {
      const text = normalizeInput(input);
      if (!text) {
        return {
          ok: false,
          plugin: 'result-analyzer',
          capability: opts.capability?.name || 'resultAnalyzer',
          error: { code: 'INVALID_INPUT', message: 'result or observation is required' },
          data: {
            status: 'insufficient_input',
            source: 'result-analyzer',
            capability: 'resultAnalyzer',
            output: {
              signal: 'mixed',
              summary: '',
              nextAction: 'experimentPlanner',
            },
            evidence: [],
            confidence: 0,
          },
          evidence: [],
          confidence: 0,
        };
      }

      const signal = classifySignal(text);
      const evidence = [{
        kind: 'analysis',
        text: `Signal classified as ${signal}: ${text}`,
        confidence: 0.55,
        source: 'result-analyzer',
      }];
      const baseConfidence = signal === 'mixed' ? 0.48 : 0.6;
      const confidence = kernel && typeof kernel.hasCapability === 'function' && kernel.hasCapability('evidenceRanking')
        ? adjustedConfidence(baseConfidence, 'docs')
        : baseConfidence;

      return {
        ok: true,
        plugin: 'result-analyzer',
        capability: opts.capability?.name || 'resultAnalyzer',
        data: {
          status: 'ready',
          source: 'result-analyzer',
          capability: 'resultAnalyzer',
          output: {
            signal,
            summary: text,
            updatedHypothesis: signal === 'support' ? 'strengthen' : signal === 'reject' ? 'revise' : 'refine',
            nextAction: signal === 'support' ? 'replicationChecker' : 'experimentPlanner',
          },
          evidence,
          confidence,
        },
        evidence,
        confidence,
      };
    },
  };
}

module.exports = createResultAnalyzerPlugin();
module.exports.create = createResultAnalyzerPlugin;
module.exports._test = { classifySignal, normalizeInput };
