import { CausalState, CausalAction, CausalPrediction, CausalInverse, CausalFailure, CausalPolicy } from './causal-runtime';
export const MAX_EPISODES: 512;
export const DEFAULT_MIN_SUPPORT: 3;

export class LearnedCausalEngine {
  constructor(options?: { episodes?: readonly Record<string, unknown>[]; withdrawn?: readonly string[]; minSupport?: number; maxOperations?: number });
  forward(input: { workspaceId: string; frameId: string; preState: CausalState; action: CausalAction }): CausalPrediction;
  inverse(input: { workspaceId: string; frameId: string; preState: CausalState; desiredState: CausalState; actions: readonly CausalAction[]; evaluatePolicy?: CausalPolicy }): CausalInverse;
  failure(input: { prediction: CausalPrediction; preState: CausalState; observedPostState: CausalState }): CausalFailure;
}
