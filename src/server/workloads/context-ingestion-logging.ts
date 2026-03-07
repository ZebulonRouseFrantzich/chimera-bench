import { sanitizeControlCharacters } from "../http/sanitize.ts";
import type { ServerLogger } from "../logging.ts";
import type { StarterWorkload } from "../runs/starter-workload.ts";

export function logContextIngestion(input: {
  logger: ServerLogger;
  requestId: string | undefined;
  workloadId: string;
  caseId: string;
  filesRead: number;
  contextBytes: number;
  truncatedFiles: number;
  omittedFiles: number;
  elapsedMs: number;
}): void {
  input.logger.info(
    `[chimera-bench]` +
      (input.requestId ? ` requestId=${sanitizeControlCharacters(input.requestId)}` : "") +
      ` event=workload.context_ingestion` +
      ` workloadId=${sanitizeControlCharacters(input.workloadId)}` +
      ` caseId=${sanitizeControlCharacters(input.caseId)}` +
      ` filesRead=${input.filesRead}` +
      ` contextBytes=${input.contextBytes}` +
      ` truncatedFiles=${input.truncatedFiles}` +
      ` omittedFiles=${input.omittedFiles}` +
      ` elapsedMs=${Math.max(0, Math.floor(input.elapsedMs))}`,
  );
}

export function logWorkloadDigestComputation(input: {
  logger: ServerLogger;
  requestId: string | undefined;
  workload: StarterWorkload;
  contextDigestsCount: number;
  digestSha256: string;
  elapsedMs: number;
}): void {
  input.logger.info(
    `[chimera-bench]` +
      (input.requestId ? ` requestId=${sanitizeControlCharacters(input.requestId)}` : "") +
      ` event=workload.digest.computed` +
      ` workloadId=${sanitizeControlCharacters(input.workload.workloadId)}` +
      ` source=${input.workload.source}` +
      ` contextDigests=${input.contextDigestsCount}` +
      ` digestSha256=${input.digestSha256}` +
      ` elapsedMs=${Math.max(0, Math.floor(input.elapsedMs))}`,
  );
}
