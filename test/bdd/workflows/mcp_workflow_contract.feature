# language: en
@workflow @mcp @issue-787
Feature: MCP tool parity, approval, and workflow observability
  Huqan MCP client’ları; UI, API ve CLI ile aynı workflow kimliklerini,
  policy/approval sonuçlarını, evidence bilgisini ve Trust Receipt bağını kullanır.

  Background:
    Given the MCP server is running with the canonical capability manifest
    And the client is connected to an authenticated workspace session
    And the approval store and deterministic receipt store are available

  @ac-787-1 @schema @manifest
  Scenario: Canonical MCP tools publish versioned machine-readable schemas
    When the client lists the MCP tools
    Then every canonical tool publishes a versioned input schema and output schema
    And every tool publishes its canonical workflowId
    And the metadata identifies the UI, API, and CLI counterparts

  @ac-787-2 @response-envelope
  Scenario: MCP workflow results use a shared response envelope
    When the client invokes a canonical read or mutation tool
    Then the result contains ok, status, data, evidence, confidence, policy, approval, trace, receiptId, and error fields
    And fields that do not apply are explicitly null or empty according to the schema
    And a successful tool call cannot be confused with a canonical write

  @ac-787-3 @learn @review-required
  Scenario: Learn tool creates a review candidate without canonical write
    Given the submitted fact requires admission or policy review
    When the client invokes huqan.learn
    Then the result status is "review_required"
    And the result includes candidateId, provenance, policy decision, and approvalId
    And canonical memory remains unchanged until approval

  @ac-787-4 @approval @idempotency
  Scenario: Approval tool applies one idempotent canonical decision
    Given a pending candidate is returned by huqan.approvals
    When the client invokes huqan.approve with an approved decision
    Then the result identifies the candidate, actor, policy decision, audit event, and receiptId
    When the client repeats the same approval decision
    Then the result is idempotent
    And no second canonical write or second receipt is created

  @ac-787-5 @read-workflows
  Scenario Outline: Read tools return evidence, confidence, provenance, and receipt context
    When the client invokes <tool> for the deterministic fixture
    Then the result status is <status>
    And the result contains the expected evidence and confidence fields
    And source or provenance references identify the basis of the result
    And the result includes a Trust Receipt identifier when the workflow emits a receipt

    Examples:
      | tool              | status    |
      | huqan.ask         | completed |
      | huqan.verify      | completed |
      | huqan.reason      | completed |
      | huqan.compare     | completed |
      | huqan.search      | completed |
      | huqan.trust_receipt | completed |

  @ac-787-6 @advocate
  Scenario: Advocate tool returns a classified counterargument
    Given the client submits a claim to the advocate workflow
    When the advocate tool completes
    Then the result contains the strongest counterargument and its evidence
    And the result classifies the claim as supported, unsupported, contradicted, or review-required
    And the result contains confidence and source references

  @ac-787-7 @plan
  Scenario: Plan tool creates an immutable plan with policy gates
    When the client invokes huqan.plan for a goal
    Then the result includes an immutable planId and version
    And each step has an ordered tool reference and policy decision
    And approval gates are explicit before mutation steps
    And changing the plan creates a new version instead of mutating the existing plan

  @ac-787-8 @agent @observability
  Scenario Outline: Agent tool exposes every lifecycle state and next action
    Given an agent run reaches <lifecycle state>
    When the client reads the huqan.agent result
    Then the result includes a stable runId and step trace
    And the result exposes the policy decision, evidence, approval reference, and nextAction
    And the client can distinguish the state from a completed run

    Examples:
      | lifecycle state |
      | paused          |
      | blocked         |
      | partial         |
      | failed          |
      | completed       |

  @ac-787-9 @resume @repair
  Scenario: Paused agent run resumes without duplicating a completed step
    Given an agent run is paused after a completed idempotent step
    When the client resumes the run with its authorized resume context
    Then the completed step is not executed again
    And the next step receives a new trace entry
    And the final result preserves the original evidence and approval references

  @ac-787-10 @ingest
  Scenario: Ingest tool separates preview from execute and supports recovery
    When the client invokes ingest preview for a source
    Then the result contains a source manifest, proposed diff, provenance, and input digest
    And no canonical memory write occurs
    When the client executes the reviewed ingest
    Then the result exposes progress, per-source status, retry or resume information, and final receipt references

  @ac-787-11 @fail-closed @policy
  Scenario Outline: MCP refuses unsafe or unavailable mutations
    Given the client sends <invalid condition>
    When the client invokes <tool>
    Then the result is <expected status>
    And the MCP server does not claim that the action was queued or completed
    And no hidden mutation is persisted

    Examples:
      | invalid condition             | tool              | expected status |
      | a policy-denied mutation      | huqan.learn       | blocked         |
      | an unknown tool               | unknown.tool      | invalid_tool    |
      | a missing approval store      | huqan.approve     | failed          |
      | an invalid review token       | huqan.approve     | unauthorized    |

  @ac-787-12 @contract-tests @security-regression
  Scenario: MCP contract and security tests cover parity and trust boundaries
    Given the MCP contract fixtures are aligned with API and CLI fixtures
    When the test suite runs schema, auth, approval, idempotency, receipt, and partial-run cases
    Then all canonical tools pass parity checks
    And unauthorized, denied, duplicate-approval, invalid-tool, and partial-run cases fail safely
    And review tokens and workspace boundaries cannot be forged or crossed
