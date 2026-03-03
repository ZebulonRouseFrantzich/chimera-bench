import {
  buildSshCommandArgv,
  executeSshCommand,
} from "../../server/ssh/ssh-exec.ts";
import { startSshPortForward } from "../../server/ssh/ssh-port-forward/index.ts";
import { TargetProfileStore } from "../../server/targets/target-profile-store.ts";
import type { TargetsCommandDependencies } from "./types.ts";

export function createDependencies(
  overrides: Partial<TargetsCommandDependencies>,
): TargetsCommandDependencies {
  return {
    targetProfiles: overrides.targetProfiles ?? new TargetProfileStore(),
    executeSsh: overrides.executeSsh ?? executeSshCommand,
    buildSshArgv: overrides.buildSshArgv ?? buildSshCommandArgv,
    startPortForward: overrides.startPortForward ?? startSshPortForward,
    addSignalListener:
      overrides.addSignalListener ??
      ((signal, listener) => {
        process.on(signal, listener);
      }),
    removeSignalListener:
      overrides.removeSignalListener ??
      ((signal, listener) => {
        process.off(signal, listener);
      }),
    env: overrides.env ?? process.env,
    print: overrides.print ?? ((message: string) => console.log(message)),
    printError:
      overrides.printError ?? ((message: string) => console.error(message)),
    writeStdout:
      overrides.writeStdout ??
      ((chunk: string) => {
        process.stdout.write(chunk);
      }),
    writeStderr:
      overrides.writeStderr ??
      ((chunk: string) => {
        process.stderr.write(chunk);
      }),
  };
}
