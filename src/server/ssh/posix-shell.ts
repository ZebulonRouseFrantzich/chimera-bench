const NUL_CHARACTER = "\u0000";

export class PosixShellQuoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PosixShellQuoteError";
  }
}

export function quotePosixShellArg(arg: string): string {
  if (arg.includes(NUL_CHARACTER)) {
    throw new PosixShellQuoteError("Remote command arguments must not contain NUL bytes.");
  }

  if (arg.length === 0) {
    return "''";
  }

  return `'${arg.replaceAll("'", "'\\''")}'`;
}

export function buildPosixShellCommand(argv: readonly string[]): string {
  if (argv.length === 0) {
    throw new PosixShellQuoteError(
      "Remote command argv must include at least one argument.",
    );
  }

  return argv.map((arg) => quotePosixShellArg(arg)).join(" ");
}
