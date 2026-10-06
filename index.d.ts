import Kernel = require('./kernel');
import KernelV2 = require('./kernel.v2');
import { CausalRuntime } from './lib/causal/causal-runtime';
import { LearnedCausalEngine } from './lib/causal/learned-causal-engine';
import { createLocalNeuralModel } from './lib/cognitive-model-local-ssm';
import { validateProposal as validateCognitiveModelProposal } from './lib/cognitive-model-port';

type A2aStageContext = Readonly<{
  workspaceId: string;
  sourceAgentId: string;
  policyVersion: string;
  now: () => string;
  signal: AbortSignal;
}>;
type A2aMessage = Readonly<Record<string, unknown>>;
type A2aIntervention =
  | { decision: 'allow' | 'drop'; reason: string; message?: never }
  | { decision: 'modify'; reason: string; message: A2aMessage };
type A2aAdmission = { decision: 'allow' | 'block' | 'drop' | 'review' | 'dryrun'; reason: string };
type A2aStage<T> = (message: A2aMessage, context: A2aStageContext) => T | Promise<T>;

/**
 * Package root export (#329).
 *
 * KernelV2 is the canonical public kernel surface, matching the runtime every
 * entry point now builds. The v1 Kernel remains reachable as a deprecated
 * named export for consumers that still depend on it directly; it is not the
 * default and not a runtime option, and it is removed in the next major.
 */
declare const huqan: typeof KernelV2 & {
  KernelV2: typeof KernelV2;
  CausalRuntime: typeof CausalRuntime;
  LearnedCausalEngine: typeof LearnedCausalEngine;
  createLocalNeuralModel: typeof createLocalNeuralModel;
  validateCognitiveModelProposal: typeof validateCognitiveModelProposal;

  /** @deprecated Use KernelV2 / require('huqan'). Removed in the next major. */
  KernelV1: typeof Kernel;

  AXIOM_ERROR: Record<string, string>;
  CONTRACT_VERSION: string;
  ProvenanceError: typeof Kernel.ProvenanceError;
  createAdmissionBypassOpts: (reason: string) => Record<string, unknown>;

  ErrorPrevention: new (memoryStore: any, options?: Record<string, unknown>) => any;
  createErrorPrevention: (memoryStore: any, options?: Record<string, unknown>) => any;
  errorPrevention: {
    ErrorPrevention: new (memoryStore: any, options?: Record<string, unknown>) => any;
    createErrorPrevention: (memoryStore: any, options?: Record<string, unknown>) => any;
    buildActionFingerprint: (input?: Record<string, unknown>) => string;
    buildFailureFingerprint: (input?: Record<string, unknown>) => string;
    buildRuleSubjectHash: (rule?: Record<string, unknown>) => string;
    classifyFailureTrust: (source: string, evidence?: unknown[]) => Record<string, unknown>;
    mergeWithUpstreamVerdict: (upstreamVerdict?: string, preventionVerdict?: string) => string;
    normalizeAction: (input?: Record<string, unknown>) => Record<string, string>;
  };

  AgentActionFirewall: Record<string, any>;
  evaluateAgentActionFirewall: (request?: Record<string, unknown>) => Record<string, unknown>;
  AGENT_ACTION_FIREWALL_VERSION: string;
  AGENT_ACTION_FIREWALL_DECISIONS: Record<string, string>;

  AgentIdentityRuntime: Record<string, any>;
  evaluateAgentIdentity: (request?: Record<string, unknown>) => Record<string, unknown>;
  composeReceiverOwnedIdentityClaim: (request?: Record<string, unknown>) => Record<string, unknown>;
  snapshotAgentIdentityAuthority: (request?: Record<string, unknown>) => Record<string, unknown>;
  AGENT_IDENTITY_RUNTIME_VERSION: string;
  IDENTITY_RUNTIME_ERRORS: Record<string, string>;

  createA2aHandoffDispatcher: (options: {
    graph: {
      runMutationOnce: (operationId: string, mutate: () => unknown,
        options: { buildCanonicalReceipt: () => Readonly<Record<string, unknown>> }) => unknown;
      getCommittedMutationReceiptByOperation: (id: string) => unknown;
      getCommittedMutationReceiptById: (id: string) => unknown;
    };
    workspaceId: string;
    sourceAgentId: string;
    policyVersion: string;
    now?: () => string;
    timeoutMs?: number;
    intervention: A2aStage<A2aIntervention>;
    prepare: A2aStage<A2aMessage>;
    verify: A2aStage<A2aAdmission>;
    admission: A2aStage<A2aAdmission>;
    dispatch: A2aStage<unknown>;
  }) => { handoff: (message: unknown) => Promise<Readonly<{
    decision: 'allow' | 'drop' | 'modify';
    status: 'in_progress' | 'blocked' | 'dropped' | 'replayed' | 'dispatched' | 'unknown';
    reason: string;
    dispatchAttempted: boolean;
    receipt?: unknown;
    outcomeReceipt?: unknown;
    response?: unknown;
    deliveryRecorded?: boolean;
    previousOutcome?: string;
  }>> };

  createA2aHandoffCursor: (directory: string) => {
    recordCursor: (cursor: {
      from_agent_id: string; to_agent_id: string;
      route_receipt_id: string; timestamp: string;
    }) => Readonly<{ recorded: boolean; duplicate?: boolean; reason?: string }>;
    readCursor: (routeReceiptId: string) => Readonly<{
      found: boolean; active?: boolean; corrupt?: boolean;
      cursor?: unknown; termination?: unknown;
    }>;
    closeCursor: (routeReceiptId: string, closure: {
      handoffReason: string; closedBy: string; timestamp: string;
    }) => Readonly<{ closed: boolean; reason?: string; termination?: unknown }>;
  };
  CURSOR_SCHEMA_VERSION: string;
  HANDOFF_TERMINATION_REASONS: Record<string, string>;
  resolveHandoffTermination: (request: {
    handoffReason: string; closedBy: string;
  }) => Readonly<{ handoffReason: string; closedBy: string; terminationReason: string }>;

  HumanOversightApprovalRuntime: Record<string, any>;
  createHumanOversightApprovalRuntime: (options: Record<string, unknown>) => Record<string, any>;
  HUMAN_OVERSIGHT_RUNTIME_VERSION: string;
  HUMAN_OVERSIGHT_RUNTIME_REASONS: Record<string, string>;

  PrGuardian: {
    TOOL: string;
    ACTIONS: Record<string, string>;
    DECISIONS: Record<string, string>;
    normalizePullRequestSnapshot: (input?: Record<string, unknown>, options?: Record<string, unknown>) => Record<string, unknown>;
    evaluatePullRequest: (snapshot?: Record<string, unknown>, options?: Record<string, unknown>) => Record<string, unknown>;
    createReviewService: (options?: Record<string, unknown>) => Record<string, (...args: any[]) => any>;
    createGitHubRestClient: (options?: Record<string, unknown>) => Record<string, (...args: any[]) => Promise<any>> | null;
  };
  PRGuardian: {
    TOOL: string;
    ACTIONS: Record<string, string>;
    DECISIONS: Record<string, string>;
    normalizePullRequestSnapshot: (input?: Record<string, unknown>, options?: Record<string, unknown>) => Record<string, unknown>;
    evaluatePullRequest: (snapshot?: Record<string, unknown>, options?: Record<string, unknown>) => Record<string, unknown>;
    createReviewService: (options?: Record<string, unknown>) => Record<string, (...args: any[]) => any>;
    createGitHubRestClient: (options?: Record<string, unknown>) => Record<string, (...args: any[]) => Promise<any>> | null;
  };

  MultiAgentCascadeGuard: {
    createMultiAgentCascadeGuard: (options?: Record<string, unknown>) => {
      run: (tasks: Array<Record<string, unknown>>, executor: (task: Record<string, unknown>, context: { attempt: number }) => Promise<Record<string, unknown>> | Record<string, unknown>) => Promise<Record<string, unknown>>;
      REASONS: Record<string, string>;
    };
    REASONS: Record<string, string>;
  };
  createMultiAgentCascadeGuard: (options?: Record<string, unknown>) => {
    run: (tasks: Array<Record<string, unknown>>, executor: (task: Record<string, unknown>, context: { attempt: number }) => Promise<Record<string, unknown>> | Record<string, unknown>) => Promise<Record<string, unknown>>;
    REASONS: Record<string, string>;
  };
  MULTI_AGENT_CASCADE_REASONS: Record<string, string>;

  TrustReceiptPilot: Record<string, any>;
  buildPilotTrustReceipt: (input: Record<string, any>) => Readonly<Record<string, any>>;
  projectPilotTrustReceipt: (receipt: Record<string, any>) => Readonly<Record<string, any>>;
  verifyPilotTrustReceipt: (receipt: Record<string, any>, options?: Record<string, any>) => { valid: boolean; reason: string | null; trustSignal?: boolean };
  verifyPilotPublicProjection: (projection: Record<string, any>, receipt: Record<string, any>) => { valid: boolean; reason: string | null };
  createPilotReceiptArchive: (records: Array<Record<string, any>>) => Readonly<Record<string, any>>;
  assertPilotTestDatabaseBoundary: (environment: Record<string, string | undefined>) => Readonly<Record<string, string>>;

  ObservabilityTelemetryClient: {
    OBSERVABILITY_CLIENT_ERRORS: Record<string, string>;
    TELEMETRY_EVENT_TYPES: readonly string[];
    createObservabilityTelemetryClient: (options: {
      service: Record<string, (...args: any[]) => any>;
      workspaceId: string;
      agentId?: string;
      runtime?: string;
    }) => {
      workspaceId: string;
      agentId: string;
      runtime: string;
      startRun: (input: Record<string, unknown>) => any;
      recordStep: (input: Record<string, unknown>) => any;
      recordGateDecision: (input: Record<string, unknown>) => any;
      finishRun: (input: Record<string, unknown>) => any;
    };
  };
  createObservabilityTelemetryClient: (options: {
    service: Record<string, (...args: any[]) => any>;
    workspaceId: string;
    agentId?: string;
    runtime?: string;
  }) => {
    workspaceId: string;
    agentId: string;
    runtime: string;
    startRun: (input: Record<string, unknown>) => any;
    recordStep: (input: Record<string, unknown>) => any;
    recordGateDecision: (input: Record<string, unknown>) => any;
    finishRun: (input: Record<string, unknown>) => any;
  };
  OBSERVABILITY_CLIENT_ERRORS: Record<string, string>;
  TELEMETRY_EVENT_TYPES: readonly string[];

  ExternalActionGuard: Record<string, any>;
  evaluateExternalAction: (input: Record<string, unknown>, options?: Record<string, unknown>) => Record<string, any>;
  recordExternalActionOutcome: (
    input: Record<string, unknown>,
    admissionReceipt: Record<string, unknown>,
    outcome: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Record<string, any>;
  recordExternalActionReview: (
    outcomeReceipt: Record<string, unknown>,
    review: Record<string, unknown>,
    options?: Record<string, unknown>,
  ) => Record<string, any>;
  latestExternalActionReview: (
    receiptPath: string,
    outcomeReceiptId: string,
  ) => Record<string, any> | null;
  ExternalActionAdapter: Record<string, any>;
  createOpenCodeGuardPlugin: (options?: Record<string, unknown>) => (...args: any[]) => Promise<Record<string, any>>;
  registerPiGuard: (pi: Record<string, any>, options?: Record<string, unknown>) => void;
  createDurableExternalActionReceiptWriter: (options?: Record<string, unknown>) => { path: string; append: (receipt: Record<string, unknown>) => Record<string, unknown>; close: () => void };
  createExternalActionReceiptWriter: (options?: Record<string, unknown>) => { path: string; append: (receipt: Record<string, unknown>) => Record<string, unknown> };

  publicReceiptToCredential: (receipt: Record<string, unknown>) => Record<string, unknown>;
  credentialToPublicReceipt: (credential: Record<string, unknown>) => Record<string, unknown>;
  HUQAN_CREDENTIAL_TYPE: string;
  publicReceiptToSpan: (receipt: Record<string, unknown>) => Record<string, unknown>;
  toOtlpHttpPayload: (spans: Record<string, unknown>[], options?: Record<string, unknown>) => Record<string, unknown>;
};

export = huqan;
