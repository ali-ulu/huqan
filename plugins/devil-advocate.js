const LLMAdapter = require('../llmAdapter');

function normalizeInput(input) {
  if (typeof input === 'string') return input.trim();
  if (input && typeof input.text === 'string') return input.text.trim();
  if (input && typeof input.idea === 'string') return input.idea.trim();
  return '';
}

function buildQuestionList(subject, statement) {
  return [
    `${subject || 'Bu fikir'} hangi olculerle basarili sayilacak?`,
    `${subject || 'Bu fikir'} icin tersini gosteren veri var mi?`,
    `${statement || 'Bu iddia'} hangi gozlem veya deney ile curutulebilir?`,
  ];
}

function createDevilAdvocatePlugin() {
  return {
    name: 'devil-advocate',
    version: '0.1.0',
    requires: ['graph'],
    optional: ['llm', 'evidenceRanking'],
    capabilities: [
      {
        name: 'devilAdvocate',
        command: 'tartis',
        description: 'Generates the strongest counterargument for an idea.',
      },
    ],

    init() {
      if (!this.adapter) {
        this.adapter = new LLMAdapter();
      }
    },

    async run(kernel, input, opts = {}) {
      const text = normalizeInput(input);
      const facts = typeof kernel.extractFacts === 'function' ? kernel.extractFacts(text, kernel.graph?._nodes) || [] : [];
      const primary = facts[0] || null;
      const subject = primary?.subject || text.split(/\s+/)[0] || 'bu fikir';
      const graphEdges = kernel.graph && typeof kernel.graph.getEdges === 'function'
        ? kernel.graph.getEdges(subject) || []
        : [];

      if (graphEdges.length > 0) {
        const supporting = graphEdges.slice(0, 3).map(edge => ({
          relation: edge.relation,
          to: edge.to,
          source: edge.source || 'graph',
        }));
        const argument = supporting
          .map(edge => `${subject} icin zaten "${edge.relation} -> ${edge.to}" kaydi var; yeni iddia bunun etkisini kanitlamiyor.`)
          .join(' ');
        return {
          ok: true,
          plugin: 'devil-advocate',
          capability: opts.capability?.name || 'devilAdvocate',
          data: {
            mode: 'graph-backed',
            fallbackUsed: false,
            subject,
            counterArgument: argument,
            evidence: supporting,
          },
        };
      }

      if (kernel.hasCapability && kernel.hasCapability('llm') && this.adapter && typeof this.adapter.ask === 'function') {
        const response = await this.adapter.ask(
          `Fikre karsi en guclu karsi argumani kur: ${text}`,
          'Kisa, net ve elestirel cevap ver. Bilinmeyenleri varsayim gibi etiketle.'
        );
        if (response && response.ok && response.data && response.data.text) {
          return {
            ok: true,
            plugin: 'devil-advocate',
            capability: opts.capability?.name || 'devilAdvocate',
            data: {
              mode: 'llm-assisted',
              fallbackUsed: true,
              fallbackLabel: 'llm-assisted',
              subject,
              counterArgument: response.data.text.trim(),
              evidence: [],
            },
          };
        }
      }

      return {
        ok: true,
        plugin: 'devil-advocate',
        capability: opts.capability?.name || 'devilAdvocate',
        data: {
          mode: 'questions',
          fallbackUsed: false,
          subject,
          counterArgument: 'Yeterli graph verisi yok; once su sorular cevaplanmali.',
          questions: buildQuestionList(subject, text),
          evidence: [],
        },
      };
    },
  };
}

module.exports = createDevilAdvocatePlugin();
module.exports.create = createDevilAdvocatePlugin;
