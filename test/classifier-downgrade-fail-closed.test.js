const { describe, it } = require('node:test');
const assert = require('node:assert');
const {
  READ_ONLY_HINTS,
  MUTATION_HINT_FAMILIES,
} = require('../lib/automation-safety-gate/automation-safety-vocabulary');
const {
  classifyAutomationOperation,
} = require('../lib/automation-safety-gate/automation-operation-classifier');
const { evaluateMemoryMutation } = require('../lib/memory-mutation-gate');
const {
  isMetadataOnlyEntry,
} = require('../lib/memory-mutation-gate/memory-mutation-entry-predicates');

describe('read-only automation classification is fail-closed (#739)', () => {
  const namedDowngrades = [
    'list delete branch',
    'show branch_delete',
    'view repo settings change',
    'inspect repo_settings_change',
  ];

  for (const operationType of namedDowngrades) {
    it(`"${operationType}" is never ALLOW`, () => {
      const finding = classifyAutomationOperation({ operationType });
      assert.notStrictEqual(finding.decision, 'allow',
        `${operationType} classified ${finding.decision} as ${finding.category}`);
      assert.notStrictEqual(finding.category, 'read_only');
    });
  }

  it('no read-only token downgrades any mutation family', () => {
    const downgraded = [];
    for (const readOnly of READ_ONLY_HINTS) {
      for (const family of MUTATION_HINT_FAMILIES) {
        for (const mutation of family) {
          const operationType = `${readOnly} ${mutation}`;
          const finding = classifyAutomationOperation({ operationType });
          if (finding.category === 'read_only' || finding.decision === 'allow') {
            downgraded.push(`${operationType} -> ${finding.decision}/${finding.category}`);
          }
        }
      }
    }
    assert.deepStrictEqual(downgraded, [], 'mutation hints downgraded to a read-only allow');
  });

  it('the mutation token order does not matter either', () => {
    const downgraded = [];
    for (const readOnly of READ_ONLY_HINTS) {
      for (const family of MUTATION_HINT_FAMILIES) {
        for (const mutation of family) {
          const finding = classifyAutomationOperation({ operationType: `${mutation} ${readOnly}` });
          if (finding.category === 'read_only' || finding.decision === 'allow') {
            downgraded.push(`${mutation} ${readOnly} -> ${finding.decision}`);
          }
        }
      }
    }
    assert.deepStrictEqual(downgraded, []);
  });

  it('a mutation hint reaching the classifier through any field still blocks read-only', () => {
    for (const field of ['target', 'branch', 'actor']) {
      const finding = classifyAutomationOperation({ operationType: 'list', [field]: 'delete branch' });
      assert.notStrictEqual(finding.category, 'read_only', `${field} carried a mutation hint into read-only`);
    }
  });

  it('genuinely read-only operations are still allowed', () => {
    for (const operationType of ['list branches', 'view pull request', 'read repository']) {
      const finding = classifyAutomationOperation({ operationType });
      assert.strictEqual(finding.decision, 'allow', `${operationType} was not allowed`);
      assert.strictEqual(finding.category, 'read_only');
    }
    assert.strictEqual(classifyAutomationOperation({ operationType: 'show ci status' }).decision, 'allow');
  });
});

describe('metadataOnly cannot downgrade a real mutation (#740)', () => {
  const mutationFlags = [
    'contentChanged',
    'linksChanged',
    'auditChanged',
    'deleted',
    'tombstoned',
    'superseded',
  ];

  it('the predicate is derived, not asserted', () => {
    assert.strictEqual(isMetadataOnlyEntry({ metadataOnly: true }), true);
    for (const flag of mutationFlags) {
      assert.strictEqual(
        isMetadataOnlyEntry({ metadataOnly: true, [flag]: true }),
        false,
        `metadataOnly survived ${flag}`,
      );
      assert.strictEqual(
        isMetadataOnlyEntry({ action: 'note', [flag]: true }),
        false,
        `a metadata action hint survived ${flag}`,
      );
    }
  });

  it('metadataOnly paired with any mutation flag is never ALLOW', () => {
    for (const flag of mutationFlags) {
      for (const entry of [
        { id: 'm1', metadataOnly: true, [flag]: true },
        { id: 'm1', action: 'note', [flag]: true },
        { id: 'm1', changeType: 'note', metadataOnly: true, [flag]: true },
      ]) {
        const result = evaluateMemoryMutation({ entries: [entry] });
        assert.notStrictEqual(
          result.decision,
          'allow',
          `${flag} with ${JSON.stringify(entry)} was allowed`,
        );
      }
    }
  });

  it('an explicit content edit still requires review', () => {
    const result = evaluateMemoryMutation({
      entries: [{ id: 'm1', metadataOnly: true, contentChanged: true }],
    });
    assert.strictEqual(result.decision, 'review');
    assert.strictEqual(result.findings[0].reason, 'CONTENT_EDIT_REQUIRES_REVIEW');
  });

  it('a clean metadata-only change is still allowed', () => {
    for (const entry of [
      { id: 'm1', metadataOnly: true },
      { id: 'm1', action: 'note' },
      { id: 'm1', metadataOnly: true, contentChanged: false, linksChanged: false },
    ]) {
      const result = evaluateMemoryMutation({ entries: [entry] });
      assert.strictEqual(result.decision, 'allow', `${JSON.stringify(entry)} was not allowed`);
    }
  });
});
