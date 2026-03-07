import type { NormalizedCreateRunRequest } from "../../api/schemas.ts";
import type { EngineRunConfig } from "../../engines/engine-plugin.ts";

export function buildEngineRunConfig(input: {
  request: NormalizedCreateRunRequest;
  caseTimeoutMs: number;
  runTimeoutMs: number;
}): EngineRunConfig {
  return {
    engineId: input.request.engineId,
    target: input.request.target,
    model: input.request.model,
    workloadId: input.request.workloadId,
    validationMode: input.request.validationMode,
    engine: {
      serverArgs: [...input.request.engine.serverArgs],
      requestParams: {
        ...input.request.engine.requestParams,
      },
    },
    ...(input.request.sweep
      ? {
          sweep: input.request.sweep,
        }
      : {}),
    timeouts: {
      caseMs: input.caseTimeoutMs,
      runMs: input.runTimeoutMs,
    },
  };
}
