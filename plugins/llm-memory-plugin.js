const LLMAdapter = require('../llmAdapter');

let adapter;

module.exports = {
  name: 'llm-memory',

  init(kernel) {
    adapter = new LLMAdapter();
  },

  afterAsk(kernel, data) {
    // #1306: adapter is only assigned in init(kernel). If afterAsk ever fires
    // before init() ran, adapter.ask(...) below would throw synchronously --
    // a throw the trailing .catch() cannot see, since catch only covers the
    // promise adapter.ask() returns, not the call that constructs it.
    if (!adapter) return data;
    // Structural first, string second: the payload now carries `unknown`, and
    // the display string is only consulted for a caller that predates it.
    if (typeof data.unknown === 'boolean' ? data.unknown : data.answer === 'Bilmiyorum') {
      adapter.ask(data.question).then(res => {
        if (res.ok) {
          kernel.learnFromLLM(res.data.text, { skipConflicts: true, maxSentences: 5 });
        }
      }).catch(() => {});
    }
    return data;
  },

  afterLearn(kernel, data) {
    const stats = kernel.graph.getStats();
    console.log(`[llm-memory] Öğrenildi: ${data.text} (${stats.nodes} düğüm, ${stats.edges} kenar)`);
  },
};
