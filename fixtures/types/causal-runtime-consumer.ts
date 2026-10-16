import { CausalFailure, CausalPrediction, PREFIX } from '../../lib/causal/causal-runtime';
import { LearnedCausalEngine, MAX_EPISODES, DEFAULT_MIN_SUPPORT } from '../../lib/causal/learned-causal-engine';

const prefix: 'causal-episode-v1:' = PREFIX;
const max: 512 = MAX_EPISODES;
const minimum: 3 = DEFAULT_MIN_SUPPORT;
void prefix; void max; void minimum;

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
