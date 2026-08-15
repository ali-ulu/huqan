'use strict';

/**
 * The `/api` command surface.
 *
 * Lifted out of server.js because that file sits at the line-count ceiling
 * recorded in scripts/file-size-baseline.json and the ratchet in
 * scripts/check-file-size.js forbids growing it (issue #328).
 *
 * Authorization is NOT decided here. The caller gates workspace-backed
 * commands on an API key via requestGuards.commandRequiresAuthentication
 * (issue #727); this module only turns an already-authorized command into a
 * response string, and returns null for anything it does not serve.
 */

const { normalizePublicApiCommandText } = require('../../requestGuards');
const { compatibilityHelpText } = require('../workflow-contract');

const HELP_TEXT = compatibilityHelpText();

/**
 * @returns {string|null} the response body, or null when the command is not
 *   part of this surface (the caller answers 403).
 */
function runPublicApiCommand(command, args, kernel) {
  switch (normalizePublicApiCommandText(command)) {
    case 'selam':
      return 'Merhaba! Bana bir sey ogretebilir veya soru sorabilirsin.';
    case 'yardim':
      return HELP_TEXT;
    case 'anlamadim':
      return 'Anlamadim. Daha uzun bir cumle yaz veya "yardim" yaz.';
    case 'sor': {
      const result = kernel.ask(args);
      const answer = result.data.answer;
      return answer === 'Bilmiyorum' ? `X ${answer}` : `Cevap: ${answer}`;
    }
    case 'durum': {
      const stats = kernel.graph.getStats();
      const gaps = kernel.detectGaps();
      const contradictions = kernel.detectContradictions();
      let out = `Durum: ${stats.nodes} düğüm, ${stats.edges} kenar, entropi: ${kernel.entropy().toFixed(3)}`;
      if (gaps.length > 0) out += `\n  ${gaps.length} baglantisiz dugum: ${gaps.slice(0, 10).join(', ')}${gaps.length > 10 ? '...' : ''}`;
      for (const item of contradictions.slice(0, 5)) {
        out += `\n  Celiski [${item.type}]: ${item.node} -> ${item.targets.join(', ')}`;
      }
      return out;
    }
    default:
      return null;
  }
}

module.exports = {
  HELP_TEXT,
  runPublicApiCommand,
};
