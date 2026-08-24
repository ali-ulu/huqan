import Kernel = require('./kernel');
import KernelV2 = require('./kernel.v2');

type TelemetryClientFactory = (options: {
  sink: { recordLifecycle: (eventName: string, data: Record<string, unknown>) => unknown };
  workspaceId: string;
  agentId?: string;
  runtime?: string;
  idFactory?: () => string;
}) => {
  startRun: (input?: Record<string, unknown>) => Readonly<{ workspaceId: string; runId: string; traceId: string }>;
  finishRun: (ids: Record<string, unknown>, fields?: Record<string, unknown>) => unknown;
  startStep: (ids: Record<string, unknown>, fields?: Record<string, unknown>) => unknown;
  finishStep: (ids: Record<string, unknown>, fields?: Record<string, unknown>) => unknown;
  gateDecision: (ids: Record<string, unknown>, fields?: Record<string, unknown>) => unknown;
};

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

  /** @deprecated Use KernelV2 / require('huqan'). Removed in the next major. */
  KernelV1: typeof Kernel;

  AXIOM_ERROR: Record<string, string>;
  CONTRACT_VERSION: string;
  ProvenanceError: typeof Kernel.ProvenanceError;
  createAdmissionBypassOpts: (reason: string) => Record<string, unknown>;

  ObservabilityClient: {
    createTelemetryClient: TelemetryClientFactory;
    safeMetadata: (value: unknown, depth?: number) => unknown;
  };
  createTelemetryClient: TelemetryClientFactory;

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
};

export = huqan;
