declare namespace Kernel {
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

/**
 * The `kernel.memory` read surface this product actually consumes.
 *
 * Records and links are `unknown` on purpose: their shape is owned by
 * lib/memory-schema.js and versioned there, so pinning a structural type here
 * would publish a second, drifting copy of it. What the declaration commits to
 * is the call shape and the result envelope, which is what a caller needs to
 * branch on `ok`.
 */
export interface MemoryListOptions {
  workspaceId?: string;
  includeTombstoned?: boolean;
  limit?: number;
  offset?: number;
}

export interface MemoryListResult {
  ok: boolean;
  memories: unknown[];
  total: number;
}

export interface MemoryQueryLinksOptions {
  workspaceId?: string;
  fromMemoryId?: string;
  toMemoryId?: string;
  relation?: string;
  includeDeleted?: boolean;
  includeTombstoned?: boolean;
  limit?: number;
  offset?: number;
}

export interface MemoryQueryLinksResult {
  ok: boolean;
  links?: unknown[];
  total?: number;
  error?: { code: string; message: string };
}

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

  constructor(opts?: Kernel.KernelOptions);

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
    appendAuditEvent(event: unknown, opts?: Record<string, unknown>): unknown;
    _consolidateEdges(dryRun?: boolean): unknown;
  };

  // The memory store's own surface is wider than this. What is declared here
  // is what this product reaches through `kernel.memory` -- server.js's
  // graph-data endpoint calls list() and queryLinks(), kernel.js calls
  // close() -- so a consumer writing the code HUQAN itself ships typechecks.
  // Declaring the remaining methods would publish a surface no caller has
  // exercised outside the memory suite; see
  // test/memory-store-surface-audit.test.js for that classification.
  memory: {
    close(): void;
    list(opts?: Kernel.MemoryListOptions): Kernel.MemoryListResult;
    queryLinks(opts?: Kernel.MemoryQueryLinksOptions): Kernel.MemoryQueryLinksResult;
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

  recordCliMutationAudit(intent: Kernel.CliMutationAuditIntent): Kernel.CliMutationAuditResult;

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

  learn(text: string, opts?: Kernel.LearnOptions): Kernel.Envelope<'learn', Kernel.LearnData>;
  learnDocument(text: string): number;
  learnDocument(text: string, opts: Kernel.LearnOptions & { returnDetails: true }): Kernel.LearnDocumentResult;
  learnDocument(text: string, opts: Kernel.LearnOptions & { returnDetails?: false }): number;
  learnDocument(text: string, opts: Kernel.LearnOptions): number | Kernel.LearnDocumentResult;
  learnFromLLM(text: string, opts?: Kernel.LearnOptions): Kernel.LearnFromLLMResult;
  ask(question: string, opts?: Record<string, unknown>): Kernel.Envelope<'ask', Kernel.AskData>;
  verify(statement: string, opts?: Record<string, unknown>): Kernel.Envelope<'verify', Kernel.VerifyData>;
  reason(subject: string, opts?: Record<string, unknown> | string): Kernel.Envelope<'reason', Kernel.ReasonData>;
  compare(left: string, right: string, opts?: Record<string, unknown> | string): Kernel.Envelope<'compare', Kernel.CompareData>;
  dream(opts?: Record<string, unknown>): Kernel.Envelope<'dream', Kernel.DreamData>;
  detectGaps(workspaceId?: string): string[];
  detectContradictions(subject?: string, workspaceId?: string): Array<{ type: string; node: string; targets: string[]; confidence: number; message?: string }>;
  entropy(workspaceId?: string): number;
  consolidate(dryRun?: boolean): { dryRun: boolean; removed: number; details: string[] };
  selfEvolve(opts?: Record<string, unknown>): Record<string, unknown>;
  startAutoThink(intervalMs?: number): void;
  stopAutoThink(): void;
  usePlugin(plugin: Record<string, unknown>): void;
}

export = Kernel;
