import { CausalFailure, CausalPrediction, LearnedCausalEngine } from '../../lib/causal/causal-runtime';

const engine = new LearnedCausalEngine();
const prediction: CausalPrediction = engine.forward({ workspaceId: 'default', frameId: 'example', preState: { a: 1 }, action: { name: 'x', args: {}, cost: 1 } });
if (prediction.status === 'PREDICTED') {
  const state: Readonly<Record<string, string | number | boolean | null>> = prediction.postState;
  const id: string = prediction.modelId;
  void state; void id;
} else {
  const absent: null = prediction.postState;
  void absent;
}
const failure: CausalFailure = engine.failure({ prediction, preState: { a: 1 }, observedPostState: { a: 1 } });
if (failure.status !== 'UNKNOWN') {
  const predicted = failure.predictedEffect;
  const observed = failure.observedEffect;
  void predicted; void observed;
}
