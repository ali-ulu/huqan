# language: en
@workflow @api @issue-786
Feature: Canonical HTTP workflow contract and UI/API parity
  Huqan HTTP client’ları, tüm workflow’ları ortak schema, auth, workspace,
  approval, idempotency, evidence ve Trust Receipt sözleşmesiyle tüketir.

  Background:
    Given the canonical workflow capability manifest is loaded
    And the API test server is running with a deterministic workspace
    And the client has a valid workspace-bound authentication context

  @ac-786-1 @compatibility
  Scenario: Compatibility API advertises only supported commands
    When the client requests the public API capability description
    Then the description lists only commands enabled on the compatibility surface
    And an unsupported workflow returns status "capability_not_available"
    And the response contains a stable error code "UNSUPPORTED_WORKFLOW"
    And the API does not return a misleading plain-text success or null result

  @ac-786-2 @versioned-contract
  Scenario Outline: Canonical workflow routes expose machine-readable contracts
    When the client sends a valid request to <workflow route>
    Then the response is validated against the <workflow> request and response schema
    And the response contains "ok", "status", "data", "error", and "traceId"
    And the response contains evidence, confidence, and receiptId when the workflow produces them

    Examples:
      | workflow route                         | workflow          |
      | POST /api/v2/workflows/ask             | ask               |
      | POST /api/v2/workflows/verify          | verify            |
      | POST /api/v2/workflows/advocate        | advocate          |
      | POST /api/v2/workflows/learn           | learn-review      |
      | GET /api/v2/approvals                  | approvals         |
      | POST /api/v2/approvals/{id}/decision   | approval-decision |
      | POST /api/v2/workflows/search          | memory-search     |
      | POST /api/v2/ingest/preview            | ingest-preview    |
      | POST /api/v2/ingest/execute            | ingest-execute    |
      | POST /api/v2/agent/plan                | agent-plan        |
      | POST /api/v2/agent/runs                | agent-run         |
      | GET /api/v2/trust-receipts/{id}        | trust-receipt     |

  @ac-786-3 @auth @workspace @security
  Scenario Outline: API routes enforce authentication and workspace boundaries
    Given the request is sent with <authentication context>
    When the client calls <route>
    Then the API returns <expected result>
    And no data or mutation from another workspace is exposed
    And sensitive read responses use "Cache-Control: no-store" and "X-Content-Type-Options: nosniff"

    Examples:
      | authentication context       | route                              | expected result              |
      | no authentication            | POST /api/v2/workflows/ask        | unauthorized                 |
      | another workspace session    | GET /api/v2/approvals             | forbidden_or_empty           |
      | valid workspace session      | GET /api/v2/trust-receipts/{id}   | authorized_workspace_result  |

  @ac-786-4 @mutation @approval
  Scenario: Mutations stop at review instead of writing canonical memory
    Given the submitted learn or ingest request requires policy review
    When the client executes the mutation route
    Then the response status is "review_required"
    And the response includes a candidateId and approvalId
    And no canonical memory write is recorded
    And the provenance and policy decision are persisted for review

  @ac-786-5 @approval @idempotency
  Scenario: Approval decision is idempotent and auditable
    Given an approval candidate exists
    When the client submits an approval decision twice with the same idempotency key
    Then both responses identify the same decision
    And only one canonical write is recorded
    And the response includes the candidate, actor, policy, audit, and receipt references

  @ac-786-6 @status-model
  Scenario Outline: API exposes a shared workflow status model
    Given the workflow finishes with <execution outcome>
    When the client reads the response
    Then the response status is <status>
    And the client can determine whether a retry, approval, resume, or user action is required
    And the error object is null only when the outcome is successful or explicitly non-error

    Examples:
      | execution outcome       | status          |
      | completed               | completed       |
      | waiting for review     | review_required |
      | policy denial           | blocked         |
      | paused run              | paused          |
      | partially completed    | partial         |
      | failed execution       | failed          |

  @ac-786-7 @manifest
  Scenario: Surface mappings are generated from one capability manifest
    When the test loads API routes, UI capabilities, MCP metadata, and CLI help
    Then every supported workflow has the same canonical workflowId and version
    And every unavailable surface is explicitly marked unavailable
    And no help text advertises an unimplemented capability

  @ac-786-8 @limits @security-regression
  Scenario Outline: API safety controls remain enforced on workflow routes
    When the client sends <request condition> to <route>
    Then the API returns <result>
    And the server does not perform a partial or hidden mutation

    Examples:
      | request condition          | route                            | result                         |
      | an oversized body           | POST /api/v2/ingest/preview      | payload_rejected               |
      | a rate-limit overflow       | POST /api/v2/workflows/ask       | rate_limited                   |
      | an unsafe command payload   | GET /api?q=unsafe-command        | forbidden                      |
      | an invalid JSON body        | POST /api/v2/workflows/verify    | invalid_input                  |

  @ac-786-9 @contract-tests
  Scenario: OpenAPI and runtime behavior remain synchronized
    Given the machine-readable API contract is loaded
    When the contract test invokes every declared route with valid and invalid fixtures
    Then each runtime response matches its declared status and schema
    And every declared error code is documented
    And no runtime route is missing from the contract

  @ac-786-10 @migration
  Scenario: Compatibility clients can migrate to the versioned workflow routes
    Given a client uses the legacy compatibility API
    When it requests the migration metadata
    Then the response identifies the canonical versioned route and deprecation status
    And the client can correlate the legacy response with a workflowId and traceId
    And the migration does not weaken authentication, workspace, rate-limit, or cache policy
