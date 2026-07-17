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
