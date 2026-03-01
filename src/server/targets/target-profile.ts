import { extendZodWithOpenApi } from "@asteasolutions/zod-to-openapi";
import { isIP } from "node:net";
import { isAbsolute } from "node:path";
import { z } from "zod";

extendZodWithOpenApi(z);

export const TARGET_PROFILE_SCHEMA_VERSION = 1;
export const TARGET_PROFILE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const DEFAULT_SSH_PORT = 22;
const DEFAULT_LLAMA_SERVER_PATH = "llama-server";
const LLAMA_SERVER_ABSOLUTE_PATH_PATTERN = /^\/[A-Za-z0-9._/-]+\/llama-server$/;
const TARGET_PROFILE_ID_MAX_LENGTH = 64;
const TARGET_PROFILE_DISPLAY_NAME_MAX_LENGTH = 256;
const TARGET_PROFILE_HOST_MAX_LENGTH = 253;
const TARGET_PROFILE_USERNAME_MAX_LENGTH = 32;
const TARGET_PROFILE_PATH_MAX_LENGTH = 4096;
const TARGET_PROFILE_REMOTE_MODEL_ROOTS_MAX_LENGTH = 64;
const PATH_CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/;
const SSH_USERNAME_PATTERN = /^[A-Za-z0-9._-]+$/;
const HOSTNAME_LABEL_PATTERN = /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/;

const AbsolutePathSchema = z
  .string()
  .trim()
  .min(1)
  .max(TARGET_PROFILE_PATH_MAX_LENGTH)
  .refine((value) => !PATH_CONTROL_CHARACTER_PATTERN.test(value), {
    message: "Path must not contain control characters.",
  })
  .refine((value) => isAbsolute(value), {
    message: "Path must be absolute.",
  });

const TargetProfileAuthSshAgentSchema = z.object({
  method: z.literal("ssh-agent"),
});

const TargetProfileAuthKeyPathSchema = z.object({
  method: z.literal("key-path"),
  privateKeyPath: AbsolutePathSchema,
});

export const TargetProfileIdSchema = z
  .string()
  .max(TARGET_PROFILE_ID_MAX_LENGTH)
  .regex(TARGET_PROFILE_ID_PATTERN, {
    message:
      "id must match the pattern ^[a-z0-9]+(?:-[a-z0-9]+)*$.",
  });

export const TargetProfileAuthSchema = z.discriminatedUnion("method", [
  TargetProfileAuthSshAgentSchema,
  TargetProfileAuthKeyPathSchema,
]);

export const TargetProfileSchema = z.object({
  schemaVersion: z.literal(TARGET_PROFILE_SCHEMA_VERSION),
  id: TargetProfileIdSchema,
  displayName: z
    .string()
    .trim()
    .min(1)
    .max(TARGET_PROFILE_DISPLAY_NAME_MAX_LENGTH),
  host: z
    .string()
    .trim()
    .min(1)
    .max(TARGET_PROFILE_HOST_MAX_LENGTH)
    .refine((value) => isValidSshHost(value), {
      message: "host must be a valid hostname or IP address.",
    }),
  port: z.number().int().min(1).max(65535).default(DEFAULT_SSH_PORT),
  username: z
    .string()
    .trim()
    .min(1)
    .max(TARGET_PROFILE_USERNAME_MAX_LENGTH)
    .regex(SSH_USERNAME_PATTERN, {
      message:
        "username must contain only ASCII letters, digits, dots, underscores, or hyphens.",
    }),
  auth: TargetProfileAuthSchema.default({
    method: "ssh-agent",
  }),
  remoteModelRoots: z
    .array(AbsolutePathSchema)
    .min(1)
    .max(TARGET_PROFILE_REMOTE_MODEL_ROOTS_MAX_LENGTH),
  llamaServerPath: z
    .string()
    .trim()
    .min(1)
    .max(TARGET_PROFILE_PATH_MAX_LENGTH)
    .default(DEFAULT_LLAMA_SERVER_PATH)
    .refine(isAllowedLlamaServerPath, {
      message:
        "llamaServerPath must be 'llama-server' or an absolute ASCII path ending with '/llama-server'.",
    }),
});

export type TargetProfile = z.infer<typeof TargetProfileSchema>;

function isAllowedLlamaServerPath(path: string): boolean {
  return (
    path === DEFAULT_LLAMA_SERVER_PATH ||
    LLAMA_SERVER_ABSOLUTE_PATH_PATTERN.test(path)
  );
}

function isValidSshHost(value: string): boolean {
  if (isIP(value) !== 0) {
    return true;
  }

  if (value.includes("..") || value.endsWith(".")) {
    return false;
  }

  const labels = value.split(".");
  if (labels.length === 0) {
    return false;
  }

  return labels.every((label) => HOSTNAME_LABEL_PATTERN.test(label));
}
