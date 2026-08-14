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
  readonly graph: Kernel['graph'];
  // KernelV2 is the canonical runtime, so this is the declaration a consumer
  // of `require('huqan')` reads. kernel.v2.js has exposed `get memory()` since
  // #329 -- added because server.js reads kernel.memory.list() and
  // .queryLinks() and would otherwise have silently reported the memory
  // surface as unavailable -- but the member was never declared here, so the
  // canonical typed surface had no `memory` at all. Mirrored from Kernel for
  // the same reason `graph` is: the getter forwards, so the types must too.
  readonly memory: Kernel['memory'];
  readonly contractVersion: string;
  getPersistenceDescriptor(): ReturnType<Kernel['getPersistenceDescriptor']>;
  reload(): void;
  persist(): void;
  optimize(): ReturnType<Kernel['optimize']>;
  usePlugin(plugin: Record<string, unknown>): void;
  entropy(): number;
  detectGaps(): string[];
  detectContradictions(): ReturnType<Kernel['detectContradictions']>;
  startAutoThink(intervalMs?: number): void;
  stopAutoThink(): void;
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
  learnDocument(text: string): number;
  learnDocument(
    text: string,
    opts: Parameters<Kernel['learnDocument']>[1] & { returnDetails: true }
  ): { learned: number; admissions: Array<Record<string, unknown>> };
  learnDocument(
    text: string,
    opts: Parameters<Kernel['learnDocument']>[1] & { returnDetails?: false }
  ): number;
  learnDocument(
    text: string,
    opts: Parameters<Kernel['learnDocument']>[1]
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
