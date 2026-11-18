'use strict';

// The approval authority's ledger store (#4601). The main classification map
// sits at the 400-line budget (#328), so this entry is merged in as a plain
// union, exactly like the #4196 injected-fetch and the #4070/#4071 clusters.
const AUTHORITY_LEDGER_CLASSIFIED = Object.freeze({
  'lib/authority/ledger-store.js': Object.freeze({
    role: 'evidence',
    why: 'the approval authority\'s append-only ledger (#3860, ADR-016 item 8): one hash-chained JSONL '
      + 'line per registration, decision, consumption and outcome, appended with an fsync. It is the audit '
      + 'trail `huqan audit --authority` checks local approvals and receipts against, so gating its own '
      + 'append would drop exactly the decisions worth recording. The target is path.join(stateDir, LEDGER_FILE) '
      + 'that the service resolves (lib/authority/service-main.js), never an agent-supplied path; the write '
      + 'reaches it through the `io` handle defaulting to node:fs, opened `\'a\'` 0600, so the inventory now '
      + 'records the append the flag-aware open rule sees',
  }),
});

module.exports = { AUTHORITY_LEDGER_CLASSIFIED };
