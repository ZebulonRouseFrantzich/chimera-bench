/**
 * Registers `/runs` API routes and their orchestration wiring.
 *
 * Handlers in this module validate input, preserve envelope conventions,
 * and bridge request lifecycle events to the run store and SSE streams.
 */
import type { Hono } from "hono";
import {
  getOrCreateRequestId,
  jsonError,
  jsonSuccess,
} from "../../api/envelope.ts";
import {
  CreateRunRequestSchema,
  MAX_SERVER_ARGS,
  normalizeCreateRunRequest,
} from "../../api/schemas.ts";
import type { EngineCatalog } from "../../engines/engine-catalog.ts";
import type {
  EngineRunConfig,
  EngineRunConfigValidationResult,
} from "../../engines/engine-plugin.ts";
import { parseJsonBody } from "../../http/request-validation.ts";
import {
  sanitizeControlCharacters,
  sanitizeErrorCode,
} from "../../http/sanitize.ts";
import type { InMemoryRunStore } from "../../runs/in-memory-run-store/index.ts";
import {
  DEFAULT_CASE_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
} from "../../runs/defaults.ts";
import {
  computeMaxSweepAdditionalServerArgs,
  validateAndPlanSweepConfig,
} from "../../runs/sweep-validation.ts";
import { validateSshModelIdentifier } from "../../runs/ssh-model-identifier-validation.ts";
import type { RunArtifactStore } from "../../runs/run-artifact-store.ts";
import { RunOrchestrator } from "../../runs/run-orchestrator/index.ts";
import { getBuiltInWorkload } from "../../runs/starter-workload.ts";
import type { TargetProfile } from "../../targets/target-profile.ts";
import {
  TargetProfileNotFoundError,
  TargetProfilePersistError,
  type TargetProfileStore,
} from "../../targets/target-profile-store.ts";
import {
  DEFAULT_SERVER_LOGGER,
  type ServerLogger,
} from "../../logging.ts";
import type { RuntimeControl } from "../../runtime-control.ts";
import { registerRunSupplementalRoutes } from "./supplemental.ts";
import { buildValidationFailurePayload } from "./shared.ts";

const RUN_CREATE_BODY_LIMIT_BYTES = 64 * 1024;

interface RegisterRunRoutesOptions {
  version: string;
  runtime: RuntimeControl;
  runStore: InMemoryRunStore;
  runArtifacts: RunArtifactStore;
  targetProfiles: TargetProfileStore;
  engines: EngineCatalog;
  logger?: ServerLogger;
}

export function registerRunRoutes(
  app: Hono,
  options: RegisterRunRoutesOptions,
): void {
  const logger = options.logger ?? DEFAULT_SERVER_LOGGER;
  const runOrchestrator = new RunOrchestrator({
    runtime: options.runtime,
    runStore: options.runStore,
    runArtifacts: options.runArtifacts,
    engines: options.engines,
  });

  app.post("/runs", async (context) => {
    if (!options.runtime.isAcceptingNewRuns()) {
      return jsonError(context, 409, {
        code: "RUN_SERVER_SHUTTING_DOWN",
        message: "The server is shutting down and cannot accept new runs.",
      });
    }

    const parsedBody = await parseJsonBody(
      context,
      CreateRunRequestSchema,
      RUN_CREATE_BODY_LIMIT_BYTES,
    );
    if (parsedBody instanceof Response) {
      return parsedBody;
    }

    const request = normalizeCreateRunRequest(parsedBody);

    const plugin = options.engines.getById(request.engineId);
    if (!plugin) {
      const safeEngineId = sanitizeControlCharacters(request.engineId);
      return jsonError(context, 400, {
        code: "ENGINE_NOT_SUPPORTED",
        message: `Engine '${safeEngineId}' is not available in this build.`,
      });
    }

    let targetProfileId: string | undefined;

    if (request.target.type === "ssh") {
      if (!plugin.capabilities.sshTarget) {
        return jsonError(context, 400, {
          code: "ENGINE_TARGET_NOT_SUPPORTED",
          message:
            `Engine '${sanitizeControlCharacters(request.engineId)}' does not support ` +
            "SSH targets.",
        });
      }

      let targetProfile: TargetProfile;
      try {
        targetProfile = await options.targetProfiles.getProfile(request.target.profileId);
      } catch (error) {
        if (error instanceof TargetProfileNotFoundError) {
          return jsonError(context, 400, {
            code: "VALIDATION_TARGET_PROFILE_NOT_FOUND",
            message:
              `Target profile '${sanitizeControlCharacters(request.target.profileId)}' ` +
              "was not found.",
          });
        }

        if (error instanceof TargetProfilePersistError) {
          const requestId = getOrCreateRequestId(context);
          logger.error(
            `[chimera-bench] requestId=${requestId} targetProfileOperation=get` +
              ` profileId=${sanitizeControlCharacters(request.target.profileId)}` +
              ` reason=${sanitizeControlCharacters(error.logReason)}`,
          );

          return jsonError(context, 500, {
            code: "TARGET_PROFILE_PERSIST_FAILED",
            message: "Failed to load target profile.",
          });
        }

        throw error;
      }

      const modelPathValidation = validateSshModelIdentifier(
        request.model.identifier,
        targetProfile.remoteModelRoots,
      );
      if (!modelPathValidation.ok) {
        return jsonError(context, 400, {
          code: "VALIDATION_MODEL_IDENTIFIER_INVALID",
          message:
            "model.identifier must be an absolute .gguf path within target profile remoteModelRoots.",
          details: {
            issues: modelPathValidation.issues.map((issue) => ({
              code: sanitizeErrorCode(issue.code, "VALIDATION_MODEL_IDENTIFIER_INVALID"),
              message: sanitizeControlCharacters(issue.message),
              path: sanitizeValidationPath(issue.path),
            })),
          },
        });
      }

      request.model.identifier = modelPathValidation.normalizedIdentifier;
      targetProfileId = targetProfile.id;
    } else if (request.target.type === "local") {
      if (!plugin.capabilities.localTarget) {
        return jsonError(context, 400, {
          code: "ENGINE_TARGET_NOT_SUPPORTED",
          message:
            `Engine '${sanitizeControlCharacters(request.engineId)}' does not support ` +
            "local targets.",
        });
      }
    } else {
      const unreachableTarget: never = request.target;
      void unreachableTarget;
      return jsonError(context, 400, {
        code: "VALIDATION_TARGET_INVALID",
        message: "Run target is invalid.",
      });
    }

    const workload = getBuiltInWorkload(request.workloadId);
    if (!workload) {
      return jsonError(context, 400, {
        code: "VALIDATION_WORKLOAD_INVALID",
        message: `Workload '${sanitizeControlCharacters(request.workloadId)}' is not available in this build.`,
      });
    }

    let totalCases = workload.cases.length;
    if (request.sweep) {
      if (workload.cases.length !== 1) {
        return jsonError(context, 400, {
          code: "VALIDATION_SWEEP_INVALID",
          message: "Sweep configuration is invalid.",
          details: {
            issues: [
              {
                code: "SWEEP_WORKLOAD_CASE_COUNT_INVALID",
                message: "Sweep runs currently support workloads with exactly one workload case.",
                path: "workloadId",
              },
            ],
          },
        });
      }

      const sweepValidation = validateAndPlanSweepConfig(request.sweep);
      if (!sweepValidation.ok) {
        return jsonError(context, 400, sweepValidation.payload);
      }

      totalCases = sweepValidation.plannedCases;
    }

    let validationResult: EngineRunConfigValidationResult;
    try {
      validationResult = await plugin.validateRunConfig(request);
    } catch (error) {
      return jsonError(context, 500, {
        code: "ENGINE_VALIDATION_FAILED",
        message: "Engine validation failed due to an unexpected internal error.",
        ...(error instanceof Error
          ? {
              details: {
                reason: error.message,
              },
            }
          : {}),
      });
    }

    if (!validationResult.ok) {
      const gpuSelectionIssue = validationResult.issues?.find((issue) => {
        return issue.code === "SERVER_ARG_GPU_SELECTION_REQUIRED";
      });
      if (gpuSelectionIssue && request.target.type === "ssh") {
        const requestId = getOrCreateRequestId(context);
        logger.info(
          `[chimera-bench] requestId=${requestId}` +
            ` event=run.validation.gpu_selection_required` +
            ` engineId=${sanitizeControlCharacters(request.engineId)}` +
            ` targetProfileId=${sanitizeControlCharacters(request.target.profileId)}` +
            ` guidance=${sanitizeControlCharacters(gpuSelectionIssue.message)}`,
        );
      }

      return jsonError(context, 400, buildValidationFailurePayload(validationResult));
    }

    request.engine.serverArgs = validationResult.normalized.serverArgs;
    request.engine.requestParams = validationResult.normalized.requestParams;
    request.model.identifier = validationResult.normalized.modelIdentifier;

    if (request.sweep) {
      const maxCombinedServerArgCount =
        request.engine.serverArgs.length +
        computeMaxSweepAdditionalServerArgs(request.sweep);
      if (maxCombinedServerArgCount > MAX_SERVER_ARGS) {
        return jsonError(context, 400, {
          code: "VALIDATION_SWEEP_INVALID",
          message: "Sweep configuration is invalid.",
          details: {
            issues: [
              {
                code: "SERVER_ARG_LIMIT_EXCEEDED",
                message:
                  `Combined engine.serverArgs and sweep fragment arguments must be <= ${MAX_SERVER_ARGS}.`,
                path: "sweep.axes.serverArgs",
              },
            ],
          },
        });
      }
    }

    const caseTimeoutMs = request.timeouts.caseMs ?? DEFAULT_CASE_TIMEOUT_MS;
    const runTimeoutMs = request.timeouts.runMs ?? DEFAULT_RUN_TIMEOUT_MS;

    const createRunResult = options.runStore.tryCreateQueuedRunDetailed({
      engineId: request.engineId,
      engineVersion: plugin.version,
      orchestratorVersion: options.version,
      target: request.target.type,
      ...(targetProfileId
        ? {
            targetProfileId,
          }
        : {}),
      modelIdentifier: request.model.identifier,
      workloadId: request.workloadId,
      engineArgs: request.engine.serverArgs,
      totalCases,
      caseTimeoutMs,
      runTimeoutMs,
    });

    if (!createRunResult.ok) {
      if (createRunResult.reason === "concurrency") {
        return jsonError(context, 409, {
          code: "RUN_CONCURRENCY_LIMIT",
          message: "Only one active run is allowed at a time.",
        });
      }

      return jsonError(context, 409, {
        code: "SERVICE_CAPACITY_REACHED",
        message: `Cannot create run because ${options.runStore.getMaxTrackedRuns()} tracked runs are already retained.`,
      });
    }

    const runId = createRunResult.runId;
    const requestId = getOrCreateRequestId(context);

    logger.info(
      `[chimera-bench] requestId=${requestId} runId=${runId} event=run.created engineId=${sanitizeControlCharacters(request.engineId)} workloadId=${sanitizeControlCharacters(request.workloadId)}`,
    );

    const runConfig: EngineRunConfig = {
      engineId: request.engineId,
      target: request.target,
      model: request.model,
      workloadId: request.workloadId,
      validationMode: request.validationMode,
      engine: {
        serverArgs: [...request.engine.serverArgs],
        requestParams: {
          ...request.engine.requestParams,
        },
      },
      ...(request.sweep
        ? {
            sweep: request.sweep,
          }
        : {}),
      timeouts: {
        caseMs: caseTimeoutMs,
        runMs: runTimeoutMs,
      },
    };

    runOrchestrator.start({
      runId,
      runConfig,
      workload,
    });

    return jsonSuccess(
      context,
      {
        runId,
      },
      202,
    );
  });
  registerRunSupplementalRoutes({
    app,
    runtime: options.runtime,
    runStore: options.runStore,
    runArtifacts: options.runArtifacts,
    logger,
  });
}

function sanitizeValidationPath(path: string | undefined): string {
  const sanitized = sanitizeControlCharacters(path ?? "(root)");
  return sanitized.length > 0 ? sanitized : "(root)";
}
