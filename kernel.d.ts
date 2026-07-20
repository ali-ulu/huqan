export type VerifyStatus = 'dogrulandi' | 'celiski' | 'bilinmiyor';

export type KernelCapabilityName =
  | 'graph'
  | 'temporal'
  | 'pluginCapabilities'
  | 'llm'
  | 'contradictionDetection'
  | 'evidenceRanking'
  | 'agentApi'
  | 'companyMode'
  | 'discoveryLoop';

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
  capabilities?: Partial<Record<KernelCapabilityName, boolean>>;
}

declare class Kernel {
  static AXIOM_ERROR: Record<string, string>;
  static CONTRACT_VERSION: string;

  constructor(opts?: KernelOptions);

  graph: {
    memoryPath: string;
    load(): void;
    save(): void;
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

  hasCapability(name: KernelCapabilityName): boolean;
  enableCapability(name: KernelCapabilityName): boolean;
  requireCapability(name: KernelCapabilityName): true;
  listCapabilities(): Array<Record<string, unknown>>;
  getCapability(name: string): Record<string, unknown> | null;
  runCapability(
    name: string,
    input: unknown,
    opts?: Record<string, unknown>
  ): Promise<unknown>;

  learn(text: string): Envelope<'learn', LearnData>;
  learnDocument(text: string, opts?: Record<string, unknown>): LearnData;
  learnFromLLM(text: string, opts?: Record<string, unknown>): Envelope<'learn', LearnData> | Record<string, unknown>;
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
