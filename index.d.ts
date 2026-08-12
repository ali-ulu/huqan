import Kernel = require('./kernel');
import KernelV2 = require('./kernel.v2');

/**
 * Package root export (#329).
 *
 * KernelV2 is the canonical public kernel surface, matching the runtime every
 * entry point now builds. The v1 Kernel remains reachable as a deprecated
 * named export for consumers that still depend on it directly; it is not the
 * default and not a runtime option, and it is removed in the next major.
 */
declare const huqan: typeof KernelV2 & {
  KernelV2: typeof KernelV2;

  /** @deprecated Use KernelV2 / require('huqan'). Removed in the next major. */
  KernelV1: typeof Kernel;

  AXIOM_ERROR: Record<string, string>;
  CONTRACT_VERSION: string;
  ProvenanceError: typeof Kernel.ProvenanceError;
  createAdmissionBypassOpts: (reason: string) => Record<string, unknown>;
};

export = huqan;
