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

export interface KernelMemoryRecord {
  memoryId: string;
  workspaceId: string;
  content: unknown;
  contentHash?: string;
  kind?: string;
  createdAt: string;
  updatedAt?: string;
  deletedAt?: string;
  supersedesMemoryId?: string;
  status?: string;
  metadata?: Record<string, unknown>;
  provenance: Record<string, unknown>;
  trustPolicyVersion: string;
}

export interface KernelMemoryLink {
  linkId: string;
  relation: string;
  fromMemoryId: string;
  toMemoryId: string;
  workspaceId: string;
  createdAt: string;
  provenance: Record<string, unknown>;
  trustPolicyVersion: string;
  strength?: number;
  metadata?: Record<string, unknown>;
}

export interface KernelMemoryApi {
  store(input: Record<string, unknown>): { ok: boolean; memory?: KernelMemoryRecord; created?: boolean; event?: Record<string, unknown>; error?: Record<string, unknown> };
  get(memoryId: string, opts?: Record<string, unknown>): { ok: boolean; memory?: KernelMemoryRecord; error?: Record<string, unknown> };
  list(opts?: Record<string, unknown>): { ok: boolean; memories: KernelMemoryRecord[]; total: number };
  search(query: string, opts?: Record<string, unknown>): { ok: boolean; memories?: KernelMemoryRecord[]; total?: number; error?: Record<string, unknown> };
  link(input: Record<string, unknown>): { ok: boolean; link?: KernelMemoryLink; event?: Record<string, unknown>; error?: Record<string, unknown>; deduped?: boolean };
  tombstone(memoryId: string, opts?: Record<string, unknown>): { ok: boolean; memory?: KernelMemoryRecord; event?: Record<string, unknown>; error?: Record<string, unknown> };
  supersede(memoryId: string, newContent: unknown, opts?: Record<string, unknown>): { ok: boolean; oldMemory?: KernelMemoryRecord; newMemory?: KernelMemoryRecord; link?: KernelMemoryLink; event?: Record<string, unknown>; oldMemoryUpdateEvent?: Record<string, unknown>; error?: Record<string, unknown> };
  contradict(memoryId: string, targetMemoryId: string, opts?: Record<string, unknown>): { ok: boolean; link?: KernelMemoryLink; event?: Record<string, unknown>; error?: Record<string, unknown>; deduped?: boolean };
}

export interface KernelOptions {
  noLoad?: boolean;
  memoryPath?: string;
  dbPath?: string;
  useSQLite?: boolean;
  paranoidMode?: boolean;
  lang?: string;
  loadPlugins?: boolean;
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

  memory: KernelMemoryApi;

  lang: string;
  contractVersion: string;
  paranoidMode: boolean;

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
