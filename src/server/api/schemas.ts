/**
 * Shared zod schemas for request validation and API envelopes.
 *
 * These schemas define the contract for route handlers, OpenAPI generation,
 * and SDK artifact output.
 */
import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { z } from "zod";
import {
  errorEnvelopeSchema,
  successEnvelopeSchema,
} from "./envelope.ts";
import {
  DEFAULT_CASE_TIMEOUT_MS,
  DEFAULT_RUN_TIMEOUT_MS,
} from "../runs/defaults.ts";
import {
  TargetProfileIdSchema as TargetProfileIdentifierSchema,
  TargetProfileSchema as TargetProfileModelSchema,
} from "../targets/target-profile.ts";

extendZodWithOpenApi(z);

export const DEFAULT_WORKLOAD_ID = "starter.v1";

const MAX_ENGINE_ID_LENGTH = 128;
const MAX_WORKLOAD_ID_LENGTH = 128;
const MAX_MODEL_IDENTIFIER_LENGTH = 4096;
export const MAX_SERVER_ARGS = 64;
const MAX_SERVER_ARG_LENGTH = 4096;
const MAX_REQUEST_PARAM_TOP_LEVEL_KEYS = 128;
const MAX_REQUEST_PARAM_KEY_LENGTH = 128;
export const MAX_REQUEST_PARAM_DEPTH = 8;
export const MAX_REQUEST_PARAM_NODES = 512;
const MAX_REQUEST_PARAM_STRING_LENGTH = 8192;
export const MAX_SWEEP_CASES = 256;
export const MAX_SWEEP_AXES_PER_NAMESPACE = 32;
export const MAX_SWEEP_AXIS_VALUES = MAX_SWEEP_CASES;
const MAX_CASE_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_RUN_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const RUN_ID_PATTERN =
  /^run_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const RunIdSchema = z.string().regex(RUN_ID_PATTERN, {
  message: "Run ID must match the format run_<uuid>.",
});
const DateTimeSchema = z.string().datetime();

export const RequestParamsSchema = z
  .record(z.string().max(MAX_REQUEST_PARAM_KEY_LENGTH), z.unknown())
  .superRefine((value, context) => {
    const keys = Object.keys(value);
    if (keys.length > MAX_REQUEST_PARAM_TOP_LEVEL_KEYS) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `engine.requestParams supports at most ${MAX_REQUEST_PARAM_TOP_LEVEL_KEYS} top-level keys.`,
      });
      return;
    }

    const state = {
      nodes: 0,
      exceededNodeBudget: false,
    };

    visitRequestParamNode(value, context, [], 0, state);
  });

export const ValidationModeSchema = z.enum(["strict", "permissive"]);

export const RunStatusSchema = z.enum([
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
]);

export const RunTargetLocalSchema = z.object({
  type: z.literal("local"),
}).strict();

export const RunTargetSshSchema = z.object({
  type: z.literal("ssh"),
  profileId: TargetProfileIdentifierSchema,
}).strict();

export const RunTargetSchema = z.discriminatedUnion("type", [
  RunTargetLocalSchema,
  RunTargetSshSchema,
]);

export const RunModelSchema = z.object({
  identifier: z.string().min(1).max(MAX_MODEL_IDENTIFIER_LENGTH),
});

export const RunEngineOptionsSchema = z.object({
  serverArgs: z
    .array(z.string().min(1).max(MAX_SERVER_ARG_LENGTH))
    .max(MAX_SERVER_ARGS)
    .optional(),
  requestParams: RequestParamsSchema.optional(),
});

const SweepAxisKeySchema = z.string().min(1).max(MAX_REQUEST_PARAM_KEY_LENGTH);

const SweepServerArgFragmentSchema = z.array(
  z.string().min(1).max(MAX_SERVER_ARG_LENGTH),
).max(MAX_SERVER_ARGS);

const SweepServerArgsAxesSchema = z
  .record(SweepAxisKeySchema, z.array(SweepServerArgFragmentSchema).max(MAX_SWEEP_AXIS_VALUES))
  .superRefine((value, context) => {
    if (Object.keys(value).length > MAX_SWEEP_AXES_PER_NAMESPACE) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `sweep.axes.serverArgs supports at most ${MAX_SWEEP_AXES_PER_NAMESPACE} axes.`,
      });
    }
  });

const SweepRequestParamsAxesSchema = z
  .record(SweepAxisKeySchema, z.array(z.unknown()).max(MAX_SWEEP_AXIS_VALUES))
  .superRefine((value, context) => {
    if (Object.keys(value).length > MAX_SWEEP_AXES_PER_NAMESPACE) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          `sweep.axes.requestParams supports at most ${MAX_SWEEP_AXES_PER_NAMESPACE} axes.`,
      });
    }
  });

const SweepAxesSchema = z
  .object({
    serverArgs: SweepServerArgsAxesSchema.optional(),
    requestParams: SweepRequestParamsAxesSchema.optional(),
  })
  .strict();

export const SweepConfigSchema = z
  .object({
    axes: SweepAxesSchema,
    repetitions: z.number().int().positive().optional(),
    maxCases: z.number().int().positive(),
  })
  .strict();

export const RunTimeoutsSchema = z
  .object({
    caseMs: z.number().int().positive().max(MAX_CASE_TIMEOUT_MS).optional(),
    runMs: z.number().int().positive().max(MAX_RUN_TIMEOUT_MS).optional(),
  })
  .superRefine((value, context) => {
    if (
      typeof value.caseMs === "number" &&
      typeof value.runMs === "number" &&
      value.caseMs > value.runMs
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["caseMs"],
        message: "timeouts.caseMs must be <= timeouts.runMs when both are provided.",
      });
    }
  });

export const CreateRunRequestSchema = z.object({
  engineId: z.string().min(1).max(MAX_ENGINE_ID_LENGTH),
  target: RunTargetSchema,
  model: RunModelSchema,
  workloadId: z.string().min(1).max(MAX_WORKLOAD_ID_LENGTH).optional(),
  engine: RunEngineOptionsSchema.optional(),
  sweep: SweepConfigSchema.optional(),
  validationMode: ValidationModeSchema.optional(),
  timeouts: RunTimeoutsSchema.optional(),
});

export const RunIdParamsSchema = z.object({
  runId: RunIdSchema,
});

export const TargetProfileIdParamsSchema = z.object({
  id: TargetProfileIdentifierSchema,
});

export const UpsertTargetProfileRequestSchema = TargetProfileModelSchema;

export const HealthDataSchema = z.object({
  healthy: z.literal(true),
  version: z.string().min(1),
});

export const EngineCapabilitiesSchema = z.object({
  chatCompletions: z.boolean(),
  localTarget: z.boolean(),
  sshTarget: z.boolean(),
  streaming: z.boolean(),
});

export const EngineValidationSummarySchema = z.object({
  status: z.enum(["ok", "error", "unknown"]),
  message: z.string().optional(),
});

export const EngineSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  version: z.string(),
  capabilities: EngineCapabilitiesSchema,
  environment: EngineValidationSummarySchema,
});

export const EnginesDataSchema = z.object({
  engines: z.array(EngineSummarySchema),
});

export const CreateRunResponseDataSchema = z.object({
  runId: RunIdSchema,
});

export const RunProgressSchema = z.object({
  totalCases: z.number().int().nonnegative(),
  completedCases: z.number().int().nonnegative(),
  failedCases: z.number().int().nonnegative(),
});

export const RunSummaryDataSchema = z.object({
  runId: RunIdSchema,
  status: RunStatusSchema,
  engineId: z.string().min(1).max(MAX_ENGINE_ID_LENGTH),
  workloadId: z.string().min(1).max(MAX_WORKLOAD_ID_LENGTH),
  model: RunModelSchema,
  createdAt: DateTimeSchema,
  startedAt: DateTimeSchema.nullable(),
  finishedAt: DateTimeSchema.nullable(),
  summary: RunProgressSchema,
});

export const RunResultDataSchema = z.object({
  runId: RunIdSchema,
  status: RunStatusSchema,
  result: z.record(z.string(), z.unknown()),
});

export const CancelRunDataSchema = z.object({
  runId: RunIdSchema,
  status: RunStatusSchema,
});

export const TargetProfileDataSchema = z.object({
  profile: TargetProfileModelSchema,
});

export const TargetProfilesDataSchema = z.object({
  profiles: z.array(TargetProfileModelSchema),
});

export const DeleteTargetProfileDataSchema = z.object({
  id: TargetProfileIdentifierSchema,
});

export const HealthEnvelopeSchema = successEnvelopeSchema(HealthDataSchema);
export const EnginesEnvelopeSchema = successEnvelopeSchema(EnginesDataSchema);
export const CreateRunEnvelopeSchema = successEnvelopeSchema(
  CreateRunResponseDataSchema,
);
export const RunSummaryEnvelopeSchema = successEnvelopeSchema(RunSummaryDataSchema);
export const RunResultEnvelopeSchema = successEnvelopeSchema(RunResultDataSchema);
export const CancelRunEnvelopeSchema = successEnvelopeSchema(CancelRunDataSchema);
export const TargetProfileEnvelopeSchema = successEnvelopeSchema(
  TargetProfileDataSchema,
);
export const TargetProfilesEnvelopeSchema = successEnvelopeSchema(
  TargetProfilesDataSchema,
);
export const DeleteTargetProfileEnvelopeSchema = successEnvelopeSchema(
  DeleteTargetProfileDataSchema,
);
export const ErrorEnvelopeSchema = errorEnvelopeSchema(z.string());

export interface NormalizedCreateRunRequest {
  engineId: string;
  target: z.infer<typeof RunTargetSchema>;
  model: z.infer<typeof RunModelSchema>;
  workloadId: string;
  engine: {
    serverArgs: string[];
    requestParams: Record<string, unknown>;
  };
  sweep?: NormalizedSweepConfig;
  validationMode: z.infer<typeof ValidationModeSchema>;
  timeouts: z.infer<typeof RunTimeoutsSchema>;
}

export interface NormalizedSweepConfig {
  axes: {
    serverArgs: Record<string, string[][]>;
    requestParams: Record<string, unknown[]>;
  };
  repetitions: number;
  maxCases: number;
}

export function normalizeCreateRunRequest(
  request: z.infer<typeof CreateRunRequestSchema>,
): NormalizedCreateRunRequest {
  return {
    engineId: request.engineId,
    target: request.target,
    model: request.model,
    workloadId: request.workloadId ?? DEFAULT_WORKLOAD_ID,
    engine: {
      serverArgs: request.engine?.serverArgs ?? [],
      requestParams: request.engine?.requestParams ?? {},
    },
    ...(request.sweep
      ? {
          sweep: normalizeSweepConfig(request.sweep),
        }
      : {}),
    validationMode: request.validationMode ?? "strict",
    timeouts: {
      caseMs: request.timeouts?.caseMs ?? DEFAULT_CASE_TIMEOUT_MS,
      runMs: request.timeouts?.runMs ?? DEFAULT_RUN_TIMEOUT_MS,
    },
  };
}

function normalizeSweepConfig(sweep: z.infer<typeof SweepConfigSchema>): NormalizedSweepConfig {
  const serverArgsAxes = Object.fromEntries(
    Object.entries(sweep.axes.serverArgs ?? {}).map(([axisKey, fragments]) => {
      return [
        axisKey,
        fragments.map((fragment) => {
          return [...fragment];
        }),
      ];
    }),
  );
  const requestParamsAxes = Object.fromEntries(
    Object.entries(sweep.axes.requestParams ?? {}).map(([axisKey, values]) => {
      return [
        axisKey,
        values.map((value) => {
          return cloneUnknown(value);
        }),
      ];
    }),
  );

  return {
    axes: {
      serverArgs: serverArgsAxes,
      requestParams: requestParamsAxes,
    },
    repetitions: sweep.repetitions ?? 1,
    maxCases: sweep.maxCases,
  };
}

function visitRequestParamNode(
  value: unknown,
  context: z.RefinementCtx,
  path: Array<string | number>,
  depth: number,
  state: {
    nodes: number;
    exceededNodeBudget: boolean;
  },
): void {
  if (state.exceededNodeBudget) {
    return;
  }

  if (depth > MAX_REQUEST_PARAM_DEPTH) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `engine.requestParams nested depth exceeds ${MAX_REQUEST_PARAM_DEPTH}.`,
      path,
    });
    return;
  }

  state.nodes += 1;
  if (state.nodes > MAX_REQUEST_PARAM_NODES) {
    state.exceededNodeBudget = true;
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `engine.requestParams exceeds node budget of ${MAX_REQUEST_PARAM_NODES}.`,
      path,
    });
    return;
  }

  if (typeof value === "string" && value.length > MAX_REQUEST_PARAM_STRING_LENGTH) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: `String values in engine.requestParams must be <= ${MAX_REQUEST_PARAM_STRING_LENGTH} characters.`,
      path,
    });
    return;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      visitRequestParamNode(value[index], context, [...path, index], depth + 1, state);
    }
    return;
  }

  if (!isPlainObject(value)) {
    return;
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    if (key.length > MAX_REQUEST_PARAM_KEY_LENGTH) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Object keys in engine.requestParams must be <= ${MAX_REQUEST_PARAM_KEY_LENGTH} characters.`,
        path: [...path, key],
      });
      continue;
    }

    visitRequestParamNode(nestedValue, context, [...path, key], depth + 1, state);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneUnknown<T>(value: T): T {
  try {
    return structuredClone(value);
  } catch {
    try {
      return JSON.parse(JSON.stringify(value)) as T;
    } catch {
      throw new Error("Failed to clone sweep axis value. Expected JSON-serializable input.");
    }
  }
}
