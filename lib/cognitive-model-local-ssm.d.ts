import { CognitiveModelProposal } from './cognitive-model-port';

export const DEFAULT_SEED: 3474;
export const DEFAULT_RESERVOIR: 24;
export const DEFAULT_RIDGE: 0.5;
export const DEFAULT_STEPS: 8;

export interface LocalNeuralModelOptions {
  /** Reservoir seed; the same seed reproduces the model. */
  readonly seed?: number;
  /** Hidden width, 1-64. */
  readonly reservoir?: number;
  /** Ridge penalty for the closed-form readout. */
  readonly ridge?: number;
  /** Bounded input length a prediction encodes. */
  readonly steps?: number;
}
export interface LocalNeuralModelDescription {
  readonly kind: 'SSM';
  readonly seed: number;
  readonly reservoir: number;
  readonly ridge: number;
  readonly steps: number;
  readonly authority: 'CANDIDATE_ONLY';
  readonly locality: 'LOCAL';
  readonly modelDigest: string;
  readonly weightsDigest: string;
}
export interface LocalNeuralModel {
  readonly kind: 'SSM';
  readonly seed: number;
  readonly reservoir: number;
  readonly steps: number;
  readonly trained: boolean;
  readonly trainingSamples: number;
  train(samples: readonly { sequence: readonly number[]; label: number }[]): LocalNeuralModel;
  predict(sequence: readonly number[]): CognitiveModelProposal;
  describe(): LocalNeuralModelDescription;
}
export function createLocalNeuralModel(options?: LocalNeuralModelOptions): LocalNeuralModel;
export function activation(sum: number): number;
