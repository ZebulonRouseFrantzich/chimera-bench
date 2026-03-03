import {
  buildSshBaseConnectionParts,
  type SshTargetConnection,
} from "./ssh-exec.ts";
import { SshPortForwardValidationError } from "./ssh-port-forward-types.ts";

export function buildSshPortForwardArgv(input: {
  profile: SshTargetConnection;
  localPort: number;
  remotePort: number;
}): string[] {
  assertPortInRange(input.localPort, "localPort");
  assertPortInRange(input.remotePort, "remotePort");

  const connection = buildSshBaseConnectionParts(input.profile);

  return [
    connection.command,
    ...connection.optionsArgv,
    "-o",
    "ExitOnForwardFailure=yes",
    "-N",
    "-L",
    `127.0.0.1:${input.localPort}:127.0.0.1:${input.remotePort}`,
    connection.destination,
  ];
}

function assertPortInRange(port: number, fieldName: string): void {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new SshPortForwardValidationError(
      `${fieldName} must be an integer between 1 and 65535.`,
    );
  }
}
