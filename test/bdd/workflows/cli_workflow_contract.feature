# language: en
@workflow @cli @issue-788
Feature: CLI guided workflows, command parity, and operator boundaries
  Huqan CLI kullanıcı ve operatörleri; öğrenme, ingest, approval, agent,
  backup ve restore işlemlerini ortak workflow kimliği, stable output ve güvenli sınırlarla yürütür.

  Background:
    Given the Huqan CLI is installed from the test package
    And the CLI uses the canonical workflow capability manifest
    And a deterministic workspace, approval store, and receipt store are available

  @ac-788-1 @help @manifest
  Scenario: CLI help advertises only enabled capabilities
    When the user runs huqan help
    Then every advertised command maps to an enabled workflow in the capability manifest
    And unavailable or not-yet-wired capabilities are explicitly marked unavailable
    And the help output does not promise a workflow that the selected surface cannot execute

  @ac-788-2 @aliases @parity
  Scenario Outline: Language aliases map to one canonical workflow
    When the user runs <alias>
    Then the parser resolves it to workflowId <workflowId>
    And the command uses the same input, status, receipt, and error contract as the canonical command

    Examples:
      | alias                    | workflowId       |
      | ask: kedi nedir          | ask              |
      | sor: kedi nedir          | ask              |
      | verify: kedi hayvandır   | verify           |
      | doğrula: kedi hayvandır  | verify           |
      | plan: hedef              | agent-plan       |
      | ajan: hedef              | agent-run        |
      | learn: kediler hayvandır | learn-review     |
      | öğret: kediler hayvandır | learn-review     |

  @ac-788-3 @json @exit-codes
  Scenario Outline: CLI JSON mode returns stable status and exit codes
    When the user runs the workflow in non-interactive JSON mode and it ends as <outcome>
    Then stdout is valid JSON without ANSI color codes or terminal-width formatting
    And the JSON contains workflowId, ok, status, data, evidence, confidence, approval, trace, receiptId, and error
    And the process exits with code <exit code>

    Examples:
      | outcome             | exit code |
      | completed            | 0         |
      | invalid input       | 2         |
      | unsupported workflow | 3         |
      | unauthorized         | 4         |
      | review required      | 5         |
      | blocked              | 6         |
      | partial              | 7         |
      | failed              | 8         |

  @ac-788-4 @learn @approval
  Scenario: CLI completes learn, review, approve, verify, and receipt workflow
    When the user runs learn with a new fact
    Then the CLI returns a review-required candidate with candidateId and provenance
    When the user lists and inspects pending approvals
    Then the candidate detail shows claim, source, provenance, confidence, policy reason, conflict, and proposed diff
    When the user approves the candidate
    Then the CLI returns the canonical write result, audit reference, and Trust Receipt identifier
    When the user verifies the learned fact
    Then the verification result points to the same canonical evidence and receipt chain

  @ac-788-5 @approval @idempotency
  Scenario: CLI approval decision is idempotent and auditable
    Given a pending candidate is available
    When the user submits the same approval decision twice
    Then the second command reports an idempotent decision
    And only one canonical write is recorded
    And the output includes candidate, actor, policy, audit, and receipt references

  @ac-788-6 @ingest
  Scenario: CLI ingest sources share one preview and execute workflow
    When the user previews a source of type <source type>
    Then the preview shows the source manifest, input digest, proposed diff, provenance, and target workspace
    And no canonical write occurs
    When the user executes the reviewed ingest
    Then the CLI reports progress, per-source status, retry or resume information, and final receipt references

    Examples:
      | source type |
      | manual      |
      | decision    |
      | github/repo |
      | markdown    |
      | json        |
      | yaml        |
      | git-log     |
      | pdf         |
      | http        |

  @ac-788-7 @ingest @batch
  Scenario: CLI batch ingest reports source-level outcomes and stable failure codes
    Given a batch contains accepted, review-required, rejected, and failed sources
    When the user runs ingest in non-interactive mode
    Then each source has its own outcome and error code
    And the command returns a stable partial or failed status according to the batch result
    And the user can resume only the failed or reviewable sources without duplicating accepted writes

  @ac-788-8 @agent-plan
  Scenario: CLI plan is immutable and exposes tool policies and approval gates
    When the user runs an agent plan for a goal
    Then the CLI prints an immutable planId and version
    And the ordered steps contain tool references, policy decisions, and approval gates
    When the user changes the goal or plan input
    Then the CLI creates a new plan version instead of mutating the previous plan

  @ac-788-9 @agent-run
  Scenario Outline: CLI agent run exposes lifecycle state and next action
    Given an agent run reaches <state>
    When the user reads the run result in JSON mode
    Then the output contains a stable runId and step status trace
    And the output includes policy result, evidence, approval reference, and nextAction
    And the state is reported as <state>

    Examples:
      | state     |
      | paused    |
      | blocked   |
      | partial   |
      | failed    |
      | completed |

  @ac-788-10 @agent-resume
  Scenario: CLI resumes an agent run without duplicating completed work
    Given an agent run is paused after a completed idempotent step
    When the user resumes the run with the authorized resume context
    Then the completed step is not executed again
    And the next step receives a new trace entry
    And the final receipt preserves the original evidence and approvals

  @ac-788-11 @backup @restore
  Scenario: CLI restore supports dry run, safety backup, and verification
    Given a valid backup manifest exists
    When the user runs restore in dry-run mode
    Then the CLI shows the files, schema/version, scope, and conflicts that would be restored
    And no target state is mutated
    When the user executes the restore
    Then a safety backup is created before mutation
    And post-restore verification checks persistence, schema, graph integrity, and receipt state

  @ac-788-12 @operator-boundary @security
  Scenario Outline: Maintenance commands enforce capability boundaries
    Given the user has capability class <capability class>
    When the user invokes <command>
    Then the command is <expected behavior>
    And an unauthorized mutation is not performed

    Examples:
      | capability class | command       | expected behavior                    |
      | user              | düşün         | allowed only as declared read/agent  |
      | user              | optimize      | denied or review-gated               |
      | operator          | backup        | allowed with manifest and audit      |
      | operator          | restore       | requires dry-run and safety backup   |
      | admin             | evolve        | allowed with policy and audit        |

  @ac-788-13 @script-mode
  Scenario: CLI script mode is locale and terminal independent
    When the test runs the same command with Turkish and English aliases
    And the command runs with and without a TTY and with different terminal widths
    Then the JSON result has the same workflowId, status, data schema, and exit code
    And no ANSI escape sequence or localized prose is required for parsing

  @ac-788-14 @integration
  Scenario: CLI integration and installed-package smoke tests cover workflow parity
    Given API, MCP, and CLI fixtures describe the same canonical workflow
    When the CLI integration and installed-tarball smoke suites run
    Then command, JSON, status, approval, evidence, and receipt fields pass parity checks
    And unsupported, unauthorized, blocked, review-required, partial, and failed outcomes fail safely
