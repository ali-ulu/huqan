export interface CLIOptions {
  kernelInstance?: any;
  kernel?: Record<string, unknown>;
  agentVersion?: 'v2' | 'v3';
}

declare class CLI {
  constructor(opts?: CLIOptions);
  kernel: any;
  parse(input: string): { command: string; args: string };
  execute(command: string, args: string): string;
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
}>;

export = CLI;
