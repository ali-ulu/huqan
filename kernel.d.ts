export type VerifyStatus = 'dogrulandi' | 'celiski' | 'bilinmiyor';

export interface EvidenceEdgeRef {
  from: string;
  to: string;
  relation: string;
}

export interface EvidenceItem {
  kind: string;
  text: string;
  confidence: number;
  nodes: string[];
  edges: EvidenceEdgeRef[];
}

export interface Envelope<TType extends string, TData> {
  ok: boolean;
  type: TType;
  data: TData;
  evidence: EvidenceItem[];
  error: null | { code: string; message: string };
  meta: Record<string, unknown>;
}

export interface LearnData {
  learned: number;
  skipped?: number;
  conflicts?: unknown[];
  alternatives?: unknown[];
  provenanceWarnings?: unknown[];
  admission?: Record<string, unknown> | null;
}

export interface LearnOptions extends Record<string, unknown> {
  returnDetails?: boolean;
}

export interface LearnDocumentResult {
  learned: number;
  admissions: Array<Record<string, unknown>>;
}

export interface LearnFromLLMResult {
  learned: number;
  skipped: number;
  conflicts: string[];
  ok?: boolean;
  error?: { code: string; message: string };
  meta?: Record<string, unknown>;
}

export interface AskData {
  answer: string;
  subject?: string;
  unknown?: boolean;
  alternatives?: number;
}

export interface VerifyData {
  status: VerifyStatus;
  confidence: number;
  contradictionReason?: string;
  risk?: Record<string, unknown>;
}

export interface ReasonData {
  subject: string;
  answer: string;
  forward?: EvidenceEdgeRef[];
  backward?: EvidenceEdgeRef[];
  cycles?: string[][];
}

export interface CompareData {
  a: string;
  b: string;
  answer: string;
  common?: EvidenceEdgeRef[];
  onlyA?: EvidenceEdgeRef[];
  onlyB?: EvidenceEdgeRef[];
  paths?: string[][];
}

export interface DreamHypothesis {
  type: string;
  from?: string;
  to?: string;
  confidence: number;
  relation?: string;
}

export interface DreamData {
  hypotheses: DreamHypothesis[];
  learned?: unknown[];
  cycle?: number;
}
export type CliMutationAuditDecision =
  | 'allow'
  | 'review'
  | 'dry_run_only'
  | 'block';

export type CliMutationAuditIntent = Readonly<{
  sourceCommand: string;
  mutationType:
    | 'persistence'
    | 'export'
    | 'state_replace'
    | 'canonical'
    | 'automation';
  eventType: 'UPDATE' | 'EXPORTED' | 'IMPORTED' | 'REVIEW';
  decision: CliMutationAuditDecision;
  executionEligible: boolean;
  reason:
    | 'cli_persist_local'
    | 'cli_backup_export_local'
    | 'cli_restore_state_replace_local'
    | 'cli_canonical_mutation_requires_review'
    | 'cli_automation_requires_review';
  actor?: string;
  workspaceId?: string;
  approvalState?:
    | 'pending'
    | 'approved'
    | 'rejected'
    | 'expired'
    | 'cancelled';
  receiptReference?: string;
}>;

export interface NormalizedAuditEvent {
  auditId: string;
  eventType: string;
  targetType: string;
  targetId: string;
  workspaceId: string;
  actor: string;
  timestamp: string;
  sourceRef: string;
  provenanceId: string;
  trustPolicyVersion: string;
  details: Readonly<Record<string, unknown>>;
}

export type CliMutationAuditResult = Readonly<{
  auditRecorded: boolean;
  event: NormalizedAuditEvent | null;
  errorCode: null | 'AUDIT_WRITE_FAILED';
}>;

export interface KernelOptions {
  noLoad?: boolean;
  memoryPath?: string;
  dbPath?: string;
  useSQLite?: boolean;
  memoryStorePath?: string;
  memoryStoreDbPath?: string;
  memoryStoreUseSQLite?: boolean;
  paranoidMode?: boolean;
  lang?: string;
  loadPlugins?: boolean;
  capabilities?: Record<string, boolean>;
  strictProvenance?: boolean;
}

declare class ProvenanceError extends Error {
  constructor(message?: string);
  name: 'ProvenanceError';
  code: 'PROVENANCE_REQUIRED';
}

declare class Kernel {
  static AXIOM_ERROR: Record<string, string>;
  static CONTRACT_VERSION: string;
  static ProvenanceError: typeof ProvenanceError;

  constructor(opts?: KernelOptions);

  /**
   * Graph surface used by the kernel. This is a structural subset of the real
   * Graph class (graph.js) covering the methods kernel.js and plugins call at
   * runtime. Method signatures are kept permissive (unknown for rich object
   * shapes) because Graph is a live JS module, not a generated binding.
   */
  graph: {
    memoryPath: string;
    load(): void;
    save(): void;
    close(): void;
    optimize(workspaceId?: string): { pruned: number; removedNodes: number };
    getStats(): { nodes: number; edges: number; [key: string]: unknown };
    // Node access
    addNode(id: string, label?: string, provenance?: unknown, opts?: Record<string, unknown>): unknown;
    getNode(id: string, workspaceId?: string): unknown | null;
    getNodes(workspaceId?: string): Record<string, unknown>;
    nodeCount(workspaceId?: string): number;
    // Edge access
    addEdge(fromId: string, toId: string, relation: string, opts?: Record<string, unknown>): unknown;
    getEdge(fromId: string, toId: string, relation: string, workspaceId?: string): unknown | null;
    getEdges(nodeId: string, workspaceId?: string): unknown[];
    getInEdges(nodeId: string, workspaceId?: string): unknown[];
    hasAnyEdge(fromId: string, toId: string, workspaceId?: string): boolean;
    edgeCount(workspaceId?: string): number;
    cosineSimilarity(aId: string, bId: string, workspaceId?: string): number;
    // Candidate claims / mutations
    // The audit-append seam is deliberately absent here. Graph does implement
    // an audit-append method and kernel.js reaches it through its private
    // wrapper, but declaring it would publish a generic audit-append surface on
    // the typed Kernel facade. recordCliMutationAudit is the only supported
    // public audit entry point; see
    // test/kernel-cli-audit-seam-contract.test.js.
    addCandidateClaim(candidate: unknown, opts?: Record<string, unknown>): unknown;
    getCandidateClaims(filters?: Record<string, unknown>): unknown[];
    runMutationOnce(
      operationId: string,
      mutate: () => unknown,
      opts?: Record<string, unknown>
    ): { replayed: boolean; result: unknown; receipt?: unknown };
    _consolidateEdges(dryRun?: boolean): unknown;
  };

  memory: {
    close(): void;
  };

  lang: string;
  contractVersion: string;
  getPersistenceDescriptor(): Readonly<{
    memoryPath: string;
    dbPath: string;
  }>;

  reload(): void;

  persist(): void;

  optimize(): {
    pruned: number;
    removedNodes: number;
  };

  recordCliMutationAudit(intent: CliMutationAuditIntent): CliMutationAuditResult;

  paranoidMode: boolean;

  hasCapability(name: string): boolean;
  enableCapability(name: string): boolean;
  requireCapability(name: string): true;
  listCapabilities(): Array<Record<string, unknown>>;
  getCapability(name: string): Record<string, unknown> | null;
  runCapability(
    name: string,
    input: unknown,
    opts?: Record<string, unknown>
  ): Promise<unknown>;

  learn(text: string, opts?: LearnOptions): Envelope<'learn', LearnData>;
  learnDocument(text: string): number;
  learnDocument(text: string, opts: LearnOptions & { returnDetails: true }): LearnDocumentResult;
  learnDocument(text: string, opts: LearnOptions & { returnDetails?: false }): number;
  learnDocument(text: string, opts: LearnOptions): number | LearnDocumentResult;
  learnFromLLM(text: string, opts?: LearnOptions): LearnFromLLMResult;
  ask(question: string, opts?: Record<string, unknown>): Envelope<'ask', AskData>;
  verify(statement: string, opts?: Record<string, unknown>): Envelope<'verify', VerifyData>;
  reason(subject: string, opts?: Record<string, unknown>): Envelope<'reason', ReasonData>;
  compare(left: string, right: string, opts?: Record<string, unknown>): Envelope<'compare', CompareData>;
  dream(opts?: Record<string, unknown>): Envelope<'dream', DreamData>;
  detectGaps(): string[];
  detectContradictions(): Array<{ type: string; node: string; targets: string[]; confidence: number; message?: string }>;
  entropy(): number;
  consolidate(dryRun?: boolean): { dryRun: boolean; removed: number; details: string[] };
  selfEvolve(opts?: Record<string, unknown>): Record<string, unknown>;
  startAutoThink(intervalMs?: number): void;
  stopAutoThink(): void;
  usePlugin(plugin: Record<string, unknown>): void;
}

export = Kernel;
