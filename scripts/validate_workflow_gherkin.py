from pathlib import Path
import re
import sys

REPO_ROOT = Path(__file__).resolve().parents[1]
ROOT = REPO_ROOT / 'test' / 'bdd' / 'workflows'
EXPECTED = {
    'ui_claim_workspace.feature': ('785', 10),
    'api_workflow_contract.feature': ('786', 10),
    'mcp_workflow_contract.feature': ('787', 12),
    'cli_workflow_contract.feature': ('788', 14),
}

VALID_PREFIXES = (
    '# language:', '@', 'Feature:', 'Background:', 'Scenario:',
    'Scenario Outline:', 'Given ', 'When ', 'Then ', 'And ', 'But ',
    'Examples:', '|', '  #', '',
)

errors = []
summary = []

for filename, (issue, expected_count) in EXPECTED.items():
    path = ROOT / filename
    if not path.exists():
        errors.append(f'{filename}: missing')
        continue
    text = path.read_text(encoding='utf-8')
    lines = text.splitlines()
    scenario_count = sum(1 for line in lines if line.startswith('  Scenario:') or line.startswith('  Scenario Outline:'))
    ac_tags = re.findall(r'@ac-(\d+)-(\d+)', text)
    issue_tags = sorted(set(number for number, _ in ac_tags))
    feature_count = sum(1 for line in lines if line.startswith('Feature:'))
    background_count = sum(1 for line in lines if line.startswith('  Background:'))
    if feature_count != 1:
        errors.append(f'{filename}: expected one Feature, got {feature_count}')
    if background_count != 1:
        errors.append(f'{filename}: expected one Background, got {background_count}')
    if scenario_count != expected_count:
        errors.append(f'{filename}: expected {expected_count} scenarios, got {scenario_count}')
    if issue_tags != [issue]:
        errors.append(f'{filename}: expected issue tag {issue}, got {issue_tags}')
    missing_ac = [str(i) for i in range(1, expected_count + 1) if f'@ac-{issue}-{i}' not in text]
    if missing_ac:
        errors.append(f'{filename}: missing acceptance tags {", ".join(missing_ac)}')
    for index, line in enumerate(lines, start=1):
        stripped = line.strip()
        if not stripped or stripped.startswith('#') or stripped.startswith('Examples:'):
            continue
        if stripped.startswith('|'):
            continue
        if stripped.startswith('@'):
            continue
        if line.startswith(('Feature:', '  Background:', '  Scenario:', '  Scenario Outline:', '    Given ', '    When ', '    Then ', '    And ', '    But ', '    Examples:')):
            continue
        if line.startswith('  ') and not line.startswith('    '):
            # Feature descriptions are valid free-text lines between Feature and Background.
            continue
        if line.startswith('      |'):
            continue
        errors.append(f'{filename}:{index}: unrecognized Gherkin line: {line}')
    summary.append((filename, issue, scenario_count, len(ac_tags), len(text)))

for filename, issue, scenarios, tags, chars in summary:
    print(f'{filename}: issue={issue} scenarios={scenarios} acceptance_tags={tags} chars={chars}')

if errors:
    print('VALIDATION_FAILED')
    for error in errors:
        print(error)
    sys.exit(1)

print('VALIDATION_OK')
