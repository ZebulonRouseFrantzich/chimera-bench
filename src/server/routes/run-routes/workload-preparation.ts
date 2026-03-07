import type { Context } from "hono";
import { jsonError } from "../../api/envelope.ts";
import { sanitizeControlCharacters } from "../../http/sanitize.ts";
import type { ServerLogger } from "../../logging.ts";
import {
  type ModelDigestService,
  type ModelInfoProvenance,
} from "../../runs/model-digest-service.ts";
import type { StarterWorkload } from "../../runs/starter-workload.ts";
import {
  prepareWorkloadForRun,
  type WorkloadPackProvenance,
  WorkloadContextIngestionError,
} from "../../workloads/context-ingestion.ts";

export async function prepareRunWorkloadAndProvenance(input: {
  context: Context;
  requestId: string;
  logger: ServerLogger;
  workload: StarterWorkload;
  workloadId: string;
  target: "local" | "ssh";
  modelIdentifier: string;
  modelDigests: ModelDigestService;
}): Promise<
  | {
      workload: StarterWorkload;
      workloadPack: WorkloadPackProvenance;
      modelInfo: ModelInfoProvenance;
    }
  | Response
> {
  let preparedWorkload = input.workload;
  let workloadPack: WorkloadPackProvenance;

  try {
    const prepared = await prepareWorkloadForRun({
      workload: input.workload,
      logger: input.logger,
      requestId: input.requestId,
    });
    preparedWorkload = prepared.workload;
    workloadPack = prepared.workloadPack;
  } catch (error) {
    if (error instanceof WorkloadContextIngestionError) {
      input.logger.error(
        `[chimera-bench] requestId=${input.requestId}` +
          " event=run.workload.context_ingestion_failed" +
          ` workloadId=${sanitizeControlCharacters(input.workloadId)}` +
          ` code=${sanitizeControlCharacters(error.code)}` +
          ` reason=${sanitizeControlCharacters(error.logReason)}`,
      );

      return jsonError(input.context, 400, {
        code: error.code,
        message: error.message,
      });
    }

    throw error;
  }

  const modelInfo = await input.modelDigests.resolveModelInfo({
    target: input.target,
    modelIdentifier: input.modelIdentifier,
    requestId: input.requestId,
  });

  return {
    workload: preparedWorkload,
    workloadPack,
    modelInfo,
  };
}
