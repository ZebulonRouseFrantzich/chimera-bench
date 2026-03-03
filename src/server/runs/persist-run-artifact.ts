import { toError } from "../error-utils.ts";
import { sanitizeControlCharacters } from "../http/sanitize.ts";
import {
  DEFAULT_SERVER_LOGGER,
  type ServerLogger,
} from "../logging.ts";
import type { InMemoryRunStore } from "./in-memory-run-store/index.ts";
import {
  type RunArtifactStore,
  RunArtifactWriteError,
} from "./run-artifact-store.ts";

interface PersistRunArtifactInput {
  runId: string;
  runStore: InMemoryRunStore;
  runArtifacts: RunArtifactStore;
  logger?: ServerLogger;
  errorField?: "runResultPersistError" | "cancelResultPersistError";
}

export async function persistRunArtifact(
  input: PersistRunArtifactInput,
): Promise<void> {
  const result = input.runStore.getRunResult(input.runId);
  if (!result) {
    return;
  }

  try {
    await input.runArtifacts.writeResult(input.runId, result);
  } catch (error) {
    const reason =
      error instanceof RunArtifactWriteError ? error.logReason : toError(error).message;
    const logger = input.logger ?? DEFAULT_SERVER_LOGGER;
    const errorField = input.errorField ?? "runResultPersistError";
    logger.error(
      `[chimera-bench] runId=${input.runId} ${errorField}=${sanitizeControlCharacters(reason)}`,
    );
  }
}
