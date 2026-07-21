import Kernel = require('./kernel');

type KernelV2LearnFromLLMResult = ReturnType<Kernel['learnFromLLM']> & {
  risk?: {
    manipulation: true;
    score: number;
    blocked: number;
    downgraded: number;
    sentences: Array<Record<string, unknown>>;
    labels: string[];
    reasons: string[];
  };
};

declare class KernelV2 {
  constructor(opts?: Record<string, unknown>);
  kernel: Kernel;
  recordCliMutationAudit(
    intent: Parameters<Kernel['recordCliMutationAudit']>[0]
  ): ReturnType<Kernel['recordCliMutationAudit']>;
  hasCapability(
    name: Parameters<Kernel['hasCapability']>[0]
  ): ReturnType<Kernel['hasCapability']>;
  enableCapability(
    name: Parameters<Kernel['enableCapability']>[0]
  ): ReturnType<Kernel['enableCapability']>;
  requireCapability(
    name: Parameters<Kernel['requireCapability']>[0]
  ): ReturnType<Kernel['requireCapability']>;
  listCapabilities(): ReturnType<Kernel['listCapabilities']>;
  getCapability(
    name: Parameters<Kernel['getCapability']>[0]
  ): ReturnType<Kernel['getCapability']>;
  runCapability(
    name: Parameters<Kernel['runCapability']>[0],
    input: Parameters<Kernel['runCapability']>[1],
    opts?: Parameters<Kernel['runCapability']>[2]
  ): ReturnType<Kernel['runCapability']>;
  learn(text: string, opts?: Record<string, unknown>): ReturnType<Kernel['learn']>;
  learnDocument(
    text: string,
    opts: Parameters<Kernel['learnDocument']>[1] & { returnDetails: true }
  ): { learned: number; admissions: Array<Record<string, unknown>> };
  learnDocument(
    text: string,
    opts?: Parameters<Kernel['learnDocument']>[1]
  ): ReturnType<Kernel['learnDocument']>;
  learnFromLLM(
    text: string,
    opts?: Parameters<Kernel['learnFromLLM']>[1]
  ): KernelV2LearnFromLLMResult;
  ask(question: string, opts?: Record<string, unknown>): ReturnType<Kernel['ask']>;
  verify(statement: string, opts?: Record<string, unknown>): ReturnType<Kernel['verify']>;
  reason(subject: string, opts?: Record<string, unknown>): ReturnType<Kernel['reason']>;
  compare(left: string, right: string, opts?: Record<string, unknown>): ReturnType<Kernel['compare']>;
  dream(opts?: Record<string, unknown>): ReturnType<Kernel['dream']>;
}

export = KernelV2;
