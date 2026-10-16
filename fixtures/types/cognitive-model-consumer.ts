import { createLocalNeuralModel, LocalNeuralModelOptions } from '../../lib/cognitive-model-local-ssm';
import { validateProposal, MODEL_AUTHORITY, CognitiveModelProposal } from '../../lib/cognitive-model-port';

const model = createLocalNeuralModel({ seed: 3474, reservoir: 24, ridge: 0.5, steps: 8 });
const trained = model.train([{ sequence: [1, 0, 1, 1, 0, 1, 1, 0], label: 1 }]);
const samples: number = trained.trainingSamples;
void samples;

const proposal: CognitiveModelProposal = model.predict([1, 1, 1, 1, 0, 0, 1, 1]);
const authority: 'CANDIDATE_ONLY' = proposal.authority;
const canonical: false = proposal.canonical;
const confidence: number = proposal.confidence;
void authority;
void canonical;
void confidence;

const validation = validateProposal(proposal);
if (validation.status === 'VALID' && validation.proposal) {
  const label: string = validation.proposal.answer.label;
  void label;
}

const options: LocalNeuralModelOptions = { seed: 1 };
void options;
void MODEL_AUTHORITY;
