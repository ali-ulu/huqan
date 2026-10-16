import { CausalRuntime } from '../../lib/causal/causal-runtime';
import { rollout, compare, explainPrediction, MAX_PLAN_STEPS, WorldModelSnapshot } from '../../lib/causal/symbolic-world-model';

const limit: 8 = MAX_PLAN_STEPS;
void limit;

const model: WorldModelSnapshot = {
  workspaceId: 'default', frameId: 'example',
  forward: () => ({ status: 'UNKNOWN', reason: 'x', postState: null, effect: null, support: [] }),
};
const unlock = { name: 'unlock', args: {}, cost: 2 };
const result = rollout(model, { preState: { door: false }, plan: [unlock], desiredState: { door: true } });
if (result.status === 'PREDICTED' && result.finalState) {
  const reached: boolean | null = result.goalReached;
  void reached;
}
const comparison = compare(model, { preState: { door: false }, desiredState: { door: true }, plans: [[unlock], [unlock, unlock]] });
const disposition: string | undefined = comparison.alternatives[0]?.disposition;
void disposition;
const explanation = explainPrediction(result);
const caveats: readonly string[] = explanation.caveats;
void caveats;

declare const runtime: CausalRuntime;
const viaRuntime = runtime.compare({ preState: { door: false }, desiredState: { door: true }, plans: [[unlock], [unlock]] });
const selectedStatus: 'SELECTED' | 'UNKNOWN' = viaRuntime.status;
void selectedStatus;
void runtime.explainPrediction(runtime.rollout({ preState: { door: false }, plan: [unlock] }));
