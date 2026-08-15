export interface CLIOptions {
  kernelInstance?: any;
  kernel?: Record<string, unknown>;
  agentVersion?: 'v2' | 'v3';
}

/**
 * Parsed CLI input. `args` is a string for most commands but some commands
 * (e.g. company-ingest) return a structured object. Use `unknown` and narrow
 * at the call site.
 */
export interface ParsedCommand {
  command: string;
  args: string | Record<string, unknown>;
  workflowId: string | null;
}

declare class CLI {
  constructor(opts?: CLIOptions);
  kernel: any;
  parse(input: string): ParsedCommand;
  /**
   * Execute a parsed command. Most commands return a string synchronously,
   * but some (mri, tartisma, celiski, etc.) return a Promise<string>. Callers
   * should `await` the result or use `Promise.resolve(execute(...))` to handle
   * both shapes.
   */
  execute(command: string, args: string | Record<string, unknown>, opts?: Record<string, unknown>): string | Promise<string>;
  start(): void;
}

export function createKernel(opts?: Record<string, unknown>): any;
export function runCliArgv(
  argv?: unknown[],
  io?: {
    stdout?: (value: string) => void;
    stderr?: (value: string) => void;
    cli?: CLI;
  }
): Promise<{
  interactive: boolean;
  exitCode: number;
  command?: string;
  decision?: string;
  workflowId?: string | null;
}>;

export = CLI;
