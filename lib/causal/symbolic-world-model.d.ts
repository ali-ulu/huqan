import { CausalState, CausalAction, CausalPrediction, CausalPolicy } from './causal-runtime';

export const MAX_PLAN_STEPS: 8;
export const MAX_PLANS: 16;
export const DEFAULT_ROLLOUT_OPERATIONS: 100000;

export interface WorldModelSnapshot {
  readonly workspaceId: string; readonly frameId: string;
  readonly evaluatePolicy?: CausalPolicy;
  forward(input: { preState: CausalState; action: CausalAction }): CausalPrediction;
}
export interface RolloutStep {
  readonly index: number; readonly action: CausalAction;
  readonly preState: CausalState; readonly preStateOrigin: 'observed' | 'predicted';
  readonly postState: CausalState; readonly effect: CausalState;
  readonly modelId: string; readonly conditions: CausalState;
  readonly support: readonly string[]; readonly independentSamples: number;
}
export interface Rollout {
  readonly level: 2; readonly status: 'PREDICTED' | 'UNKNOWN' | 'REJECTED'; readonly reason: string;
  readonly stoppedAt: number | null; readonly steps: readonly RolloutStep[];
  readonly finalState: CausalState | null; readonly goalReached: boolean | null;
  readonly totalCost: number | null; readonly supportFloor: number | null; readonly operations?: number;
  readonly rejectedAction?: CausalAction; readonly unknownAction?: CausalAction;
  readonly authority: 'PREDICTIVE_MODEL_ONLY'; readonly executes: false;
}
export interface PlanAlternative {
  readonly index: number; readonly plan: readonly CausalAction[]; readonly status: Rollout['status'];
  readonly disposition: 'selected' | 'feasible_not_selected' | 'goal_not_reached' | 'unknown' | 'policy_rejected';
  readonly reason: string; readonly rollout: Rollout;
}
export interface PlanComparison {
  readonly level: 2; readonly status: 'SELECTED' | 'UNKNOWN'; readonly reason: string;
  readonly selected: PlanAlternative | null; readonly alternatives: readonly PlanAlternative[];
  readonly authority: 'PREDICTIVE_MODEL_ONLY'; readonly executes: false;
}
export interface PredictionExplanation {
  readonly level: 2; readonly status: Rollout['status'];
  readonly steps: readonly { readonly index: number; readonly action: string; readonly preStateOrigin: 'observed' | 'predicted'; readonly effect: CausalState;
    readonly modelId: string; readonly conditions: CausalState; readonly independentSamples: number; readonly supportSources: number }[];
  readonly stop: { readonly index: number; readonly status: Rollout['status']; readonly reason: string; readonly action: CausalAction | null } | null;
  readonly supportFloor: number | null; readonly caveats: readonly string[];
}
export interface RolloutInput { preState: CausalState; plan: readonly CausalAction[]; desiredState?: CausalState; maxOperations?: number; }
export function rollout(model: WorldModelSnapshot, input: RolloutInput): Rollout;
export function compare(model: WorldModelSnapshot, input: { preState: CausalState; desiredState: CausalState; plans: readonly (readonly CausalAction[])[]; maxOperations?: number }): PlanComparison;
export function explainPrediction(result: Rollout): PredictionExplanation;
