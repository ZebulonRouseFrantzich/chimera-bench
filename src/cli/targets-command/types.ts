import type { buildSshCommandArgv, executeSshCommand } from "../../server/ssh/ssh-exec.ts";
import type { startSshPortForward } from "../../server/ssh/ssh-port-forward/index.ts";
import type { TargetProfileStore } from "../../server/targets/target-profile-store.ts";

export interface TargetsCommandDependencies {
  readonly targetProfiles: TargetProfileStore;
  readonly executeSsh: typeof executeSshCommand;
  readonly buildSshArgv: typeof buildSshCommandArgv;
  readonly startPortForward: typeof startSshPortForward;
  readonly addSignalListener: (
    signal: "SIGINT" | "SIGTERM",
    listener: () => void,
  ) => void;
  readonly removeSignalListener: (
    signal: "SIGINT" | "SIGTERM",
    listener: () => void,
  ) => void;
  readonly env: NodeJS.ProcessEnv;
  readonly print: (message: string) => void;
  readonly printError: (message: string) => void;
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
}

export class TargetsCommandUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetsCommandUsageError";
  }
}

export class TargetsCommandRuntimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetsCommandRuntimeError";
  }
}

export interface ParsedExecOptions {
  readonly profileId: string;
  readonly dryRun: boolean;
  readonly remoteArgv: string[];
}

export interface ParsedForwardOptions {
  readonly profileId: string;
  readonly remotePort: number;
  readonly printLocalPortOnly: boolean;
}
