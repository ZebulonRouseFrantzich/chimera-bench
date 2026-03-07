import { z } from "zod";
import { successEnvelopeSchema } from "./envelope.ts";

const MAX_WORKLOAD_ID_LENGTH = 128;

export const WorkloadIdParamsSchema = z.object({
  workloadId: z.string().min(1).max(MAX_WORKLOAD_ID_LENGTH),
});

export const WorkloadDetailQuerySchema = z.object({
  includePrompts: z.literal("1").optional(),
});

export const WorkloadMessageSchema = z.object({
  role: z.enum(["system", "user", "assistant"]),
  content: z.string().min(1),
});

export const WorkloadPromptSchema = z.object({
  promptId: z.string().min(1).max(MAX_WORKLOAD_ID_LENGTH),
  caseId: z.string().min(1).max(MAX_WORKLOAD_ID_LENGTH),
  messages: z.array(WorkloadMessageSchema).min(1),
  contextFiles: z.array(z.string().min(1)).optional(),
  notes: z.string().optional(),
});

export const WorkloadSummarySchema = z.object({
  workloadId: z.string().min(1).max(MAX_WORKLOAD_ID_LENGTH),
  displayName: z.string().min(1),
  version: z.string().min(1),
  promptCount: z.number().int().nonnegative(),
  source: z.enum(["built-in", "filesystem"]),
});

export const WorkloadsDataSchema = z.object({
  workloads: z.array(WorkloadSummarySchema),
});

export const WorkloadDetailDataSchema = WorkloadSummarySchema.extend({
  promptIds: z.array(z.string().min(1).max(MAX_WORKLOAD_ID_LENGTH)),
  prompts: z.array(WorkloadPromptSchema).optional(),
});

export const WorkloadsReloadDataSchema = z.object({
  discoveredPacks: z.number().int().nonnegative(),
  skippedInvalidPacks: z.number().int().nonnegative(),
  duplicateIdSkips: z.number().int().nonnegative(),
});

export const WorkloadsEnvelopeSchema = successEnvelopeSchema(WorkloadsDataSchema);
export const WorkloadDetailEnvelopeSchema = successEnvelopeSchema(WorkloadDetailDataSchema);
export const WorkloadsReloadEnvelopeSchema = successEnvelopeSchema(
  WorkloadsReloadDataSchema,
);
