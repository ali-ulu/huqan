export type CausalState = Readonly<Record<string, string | number | boolean | null>>;
export const PREFIX: 'causal-episode-v1:';
export interface CausalAction { readonly name: string; readonly args?: CausalState; readonly cost: number; }
export interface CausalPredicted {
  readonly status: 'PREDICTED'; readonly reason: string;
  readonly postState: CausalState; readonly effect: CausalState;
  readonly support: readonly string[]; readonly modelId: string; readonly conditions: CausalState;
  readonly independentSamples: number; readonly confidence: number; readonly operations: number;
  readonly authority: 'PREDICTIVE_MODEL_ONLY'; readonly canonicalRule: false;
}
export interface CausalUnknown { readonly status: 'UNKNOWN'; readonly reason: string; readonly postState: null; readonly effect: null; readonly support: readonly string[]; readonly operations?: number; }
export type CausalPrediction = CausalPredicted | CausalUnknown;
export interface CausalCandidate { readonly action: CausalAction; readonly prediction: CausalPrediction; }
export interface CausalInverse {
  readonly status: 'CANDIDATES' | 'UNKNOWN'; readonly reason: string;
  readonly candidates: readonly CausalCandidate[];
  readonly rejected: readonly { readonly action: CausalAction; readonly reason: string }[];
}
export interface CausalObservedFailure {
  readonly status: 'MISMATCH' | 'CONFIRMED'; readonly modelId: string;
  readonly predictedEffect: CausalState; readonly observedEffect: CausalState;
  readonly differences: readonly string[];
  readonly hypothesis: { readonly status: 'UNVERIFIED'; readonly reason: string; readonly affectedKeys: readonly string[]; readonly canonicalRule: false } | null;
}
export type CausalFailure = CausalObservedFailure | Readonly<{ status: 'UNKNOWN'; reason: string }>;
export type CausalPolicy = (request: { readonly workspaceId: string; readonly frameId: string; readonly preState: CausalState; readonly action: CausalAction }) => { readonly verdict: string; readonly reason?: string };
export interface CausalGraph {
  runMutationOnce(operationId: string, mutate: () => Record<string, unknown>): { result: Record<string, unknown>; replayed?: boolean };
  getCommittedMutationResultsByPrefix(prefix: string): { result: Record<string, unknown> }[];
}
export interface CausalJournal { read(runId: string): readonly Record<string, unknown>[]; }
export class CausalRuntime {
  constructor(options: { graph: CausalGraph; journal: CausalJournal; workspaceId?: string; frameId: string; evaluatePolicy?: CausalPolicy; minSupport?: number; maxOperations?: number });
  observeJournalEpisode(input: { runId: string; eventId: string }): Readonly<{ episode: Readonly<Record<string, unknown>>; replayed: boolean }>;
  withdrawSupport(input: { sourceHash: string; reason: string }): Readonly<{ sourceHash: string; replayed: boolean }>;
  forward(input: { preState: CausalState; action: CausalAction }): CausalPrediction;
  inverse(input: { preState: CausalState; desiredState: CausalState; actions: readonly CausalAction[] }): CausalInverse;
  failure(input: { prediction: CausalPrediction; preState: CausalState; runId: string; eventId: string }): CausalFailure;
  inspect(): Readonly<{ workspaceId: string; frameId: string; episodes: number; withdrawn: readonly string[]; sourceHashes: readonly string[] }>;
}
