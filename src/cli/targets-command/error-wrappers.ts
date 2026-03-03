import { toError } from "../../server/error-utils.ts";
import { sanitizeControlCharacters } from "../../server/http/sanitize.ts";
import {
  SshCommandExecutionError,
  SshCommandValidationError,
} from "../../server/ssh/ssh-exec.ts";
import {
  SshPortForwardExecutionError,
  SshPortForwardValidationError,
} from "../../server/ssh/ssh-port-forward/index.ts";
import {
  TargetProfileDeleteError,
  TargetProfilePersistError,
} from "../../server/targets/target-profile-store.ts";
import { TargetsCommandRuntimeError } from "./types.ts";

export function wrapSshCommandError(prefix: string, error: unknown): TargetsCommandRuntimeError {
  if (error instanceof SshCommandValidationError) {
    return new TargetsCommandRuntimeError(
      `${prefix} ${sanitizeControlCharacters(error.message)}`,
    );
  }

  if (error instanceof SshCommandExecutionError) {
    const details: string[] = [];
    if (error.details.stderrExcerpt.length > 0) {
      details.push(`stderr excerpt: ${sanitizeControlCharacters(error.details.stderrExcerpt)}`);
    }

    if (error.details.stdoutExcerpt.length > 0) {
      details.push(`stdout excerpt: ${sanitizeControlCharacters(error.details.stdoutExcerpt)}`);
    }

    const suffix = details.length > 0 ? ` ${details.join(" ")}` : "";
    return new TargetsCommandRuntimeError(
      `${prefix} ${sanitizeControlCharacters(error.message)}${suffix}`,
    );
  }

  return new TargetsCommandRuntimeError(
    `${prefix} ${sanitizeControlCharacters(toError(error).message)}`,
  );
}

export function wrapSshPortForwardError(
  prefix: string,
  error: unknown,
): TargetsCommandRuntimeError {
  if (error instanceof SshPortForwardValidationError) {
    return new TargetsCommandRuntimeError(
      `${prefix} ${sanitizeControlCharacters(error.message)}`,
    );
  }

  if (error instanceof SshPortForwardExecutionError) {
    const details: string[] = [];
    if (error.details.stderrExcerpt.length > 0) {
      details.push(`stderr excerpt: ${sanitizeControlCharacters(error.details.stderrExcerpt)}`);
    }

    if (error.details.stdoutExcerpt.length > 0) {
      details.push(`stdout excerpt: ${sanitizeControlCharacters(error.details.stdoutExcerpt)}`);
    }

    const suffix = details.length > 0 ? ` ${details.join(" ")}` : "";
    return new TargetsCommandRuntimeError(
      `${prefix} ${sanitizeControlCharacters(error.message)}${suffix}`,
    );
  }

  return new TargetsCommandRuntimeError(
    `${prefix} ${sanitizeControlCharacters(toError(error).message)}`,
  );
}

export function wrapTargetStoreError(prefix: string, error: unknown): TargetsCommandRuntimeError {
  if (error instanceof TargetProfilePersistError || error instanceof TargetProfileDeleteError) {
    return new TargetsCommandRuntimeError(
      `${prefix} ${sanitizeControlCharacters(error.message)}`,
    );
  }

  return new TargetsCommandRuntimeError(
    `${prefix} ${sanitizeControlCharacters(toError(error).message)}`,
  );
}
