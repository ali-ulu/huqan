export const COGNITIVE_MODEL_SCHEMA_VERSION: 'huqan-cognitive-model-v1';
export const MODEL_AUTHORITY: 'CANDIDATE_ONLY';
export const MODEL_KINDS: readonly ('RWKV' | 'MAMBA' | 'SSM' | 'TRANSFORMER' | 'DETERMINISTIC')[];
export const MODEL_LOCALITY: readonly ('LOCAL' | 'EXTERNAL')[];
export const PORT_STATUS: Readonly<{ VALID: 'VALID'; REJECT: 'REJECT' }>;
export const PORT_ERROR_CODES: Readonly<{
  INVALID_FIELD: 'cognitive_model_invalid_field';
  MISSING_FIELD: 'cognitive_model_missing_field';
  UNKNOWN_FIELD: 'cognitive_model_unknown_field';
  NON_FINITE_NUMBER: 'cognitive_model_non_finite_number';
  EXTERNAL_CALL: 'cognitive_model_external_call';
}>;

export interface CognitiveModelAnswer { readonly label: string; readonly score: number; }
export interface CognitiveModelBudget { readonly modelCalls: number; readonly tokens: number; readonly operations: number; }
export interface CognitiveModelProposal {
  readonly schemaVersion: 'huqan-cognitive-model-v1';
  readonly modelId: string;
  readonly kind: 'RWKV' | 'MAMBA' | 'SSM' | 'TRANSFORMER' | 'DETERMINISTIC';
  readonly locality: 'LOCAL' | 'EXTERNAL';
  readonly modelDigest: string;
  readonly answer: CognitiveModelAnswer;
  readonly confidence: number;
  readonly budget: CognitiveModelBudget;
  readonly authority: 'CANDIDATE_ONLY';
  readonly canonical: false;
}
export interface ProposalError { readonly code: string; readonly path: string; readonly message: string; }
export interface ProposalValidation {
  readonly status: 'VALID' | 'REJECT';
  readonly errors: readonly ProposalError[];
  readonly proposal: CognitiveModelProposal | null;
}
export function validateProposal(input: unknown): ProposalValidation;
export function buildProposal(input: unknown): CognitiveModelProposal;
