# language: en
@workflow @ui @issue-785
Feature: Claim Workspace and Review Inbox
  Huqan kullanıcısı, iddiaları doğrulamak, bilinmeyen bilgileri incelemeye göndermek,
  approval kararı vermek ve Trust Receipt’e ulaşmak için tamamlanmış bir UI workflow’u kullanır.

  Background:
    Given the Huqan local UI is running against an authenticated workspace
    And the workspace has a deterministic test graph and receipt store
    And the UI uses the canonical workflow capability manifest

  @ac-785-1 @verify @ask @advocate
  Scenario: UI actions call real authenticated workflow endpoints
    When the user submits an ask, verify, and advocate action from Claim Workspace
    Then each action sends a request to its canonical authenticated endpoint
    And no action is reduced to an unsupported free-text command dispatch
    And each response contains a workflow status and a trace identifier

  @ac-785-2 @file-import
  Scenario: Text and Markdown import shows a preview before execution
    Given the user selects a valid .txt or .md file
    When the browser parses the selected file
    Then the UI shows the file name, media type, size, character count, source hash, and target workspace
    And the UI does not write the file directly to canonical memory
    When the user confirms the preview
    Then the UI sends the import to the canonical ingest preview workflow

  @ac-785-3 @review-required
  Scenario: Unknown answer becomes a review candidate without bypassing approval
    Given the graph cannot support the submitted claim
    When the user chooses "Send to Review" from the unknown result
    Then the UI creates a review candidate containing the claim, source, and user rationale
    And the response status is "review_required"
    And no canonical memory write occurs before an approval decision

  @ac-785-4 @approval
  Scenario: Review Inbox lists candidate evidence and policy context
    Given a pending candidate exists for the authenticated workspace
    When the user opens Review Inbox
    Then the candidate list contains the claim, source, provenance, confidence, policy reason, conflict state, and proposed diff
    And candidates from another workspace are not visible

  @ac-785-5 @approval @idempotency
  Scenario: User approves or rejects a candidate and sees the final decision
    Given the user opens a pending candidate detail view
    When the user approves the candidate
    Then the UI shows the canonical write result, audit reference, and Trust Receipt identifier
    When the user repeats the same approval request
    Then the UI shows the idempotent result without creating a second canonical write
    When the user rejects a candidate
    Then the UI shows the rejected decision and the candidate remains non-canonical

  @ac-785-6 @memory-search
  Scenario: Memory search returns filterable results and workflow handoffs
    When the user searches memory by claim, node, source reference, provenance identifier, workspace, and confidence
    Then the UI displays matching claims and nodes with their source and provenance references
    And the user can continue from a result to ask, verify, or inspect its Trust Receipt
    And the search action does not merely switch to the Graph tab

  @ac-785-7 @advocate
  Scenario: Advocate result explains support and opposition evidence
    Given the user submits a claim to Devil's Advocate
    When the advocate workflow completes
    Then the UI shows the strongest counterargument and the supporting evidence for it
    And the UI labels the result as supported, unsupported, contradicted, or review-required
    And the UI displays confidence and source references

  @ac-785-8 @trust-handoff
  Scenario: User follows a claim result to provenance and audit evidence
    Given an ask, verify, or approval result contains a Trust Receipt identifier
    When the user opens the receipt link
    Then the UI shows the receipt integrity state, provenance chain, and audit event
    And the receipt view is bound to the same workspace and claim

  @ac-785-9 @error-handling
  Scenario Outline: UI exposes actionable workflow errors
    Given the canonical workflow endpoint responds with <response>
    When the user submits the corresponding action
    Then the UI shows the status <status>
    And the UI explains the failed step and the next safe action
    And the UI does not display the result as a successful workflow

    Examples:
      | response                         | status              |
      | an unauthenticated request       | unauthorized        |
      | a forbidden policy decision      | blocked             |
      | an oversized upload              | payload_rejected    |
      | a rate-limit response            | rate_limited        |
      | a review-gated mutation          | review_required     |
      | a partially completed run        | partial             |
      | an unexpected server failure     | failed              |

  @ac-785-10 @browser-smoke @contract
  Scenario: Browser smoke test covers the complete claim workflow
    Given the test runner uses the real route contract and deterministic test fixtures
    When it executes verify, unknown-to-review, approval decision, memory search, and receipt handoff
    Then every step completes without a mock-only success path
    And the browser console contains no uncaught workflow error
    And the displayed capability list matches the server capability manifest
