/**
 * Built-in workload definitions and runtime conversion helpers.
 *
 * This module is the source of truth for compiled workload packs that ship
 * with the server binary. Built-ins are expressed in workload-pack shape and
 * converted into runtime-ready case payloads with deterministic prompt text.
 */
import { Buffer } from "node:buffer";

export type WorkloadMessageRole = "system" | "user" | "assistant";

export interface WorkloadMessage {
  role: WorkloadMessageRole;
  content: string;
}

export interface WorkloadPromptDefinition {
  promptId: string;
  caseId: string;
  messages: readonly WorkloadMessage[];
  contextFiles?: readonly string[] | undefined;
  notes?: string | undefined;
}

export interface WorkloadPackDefinition {
  schemaVersion: number;
  workloadId: string;
  displayName: string;
  version: string;
  prompts: readonly WorkloadPromptDefinition[];
}

export interface StarterWorkloadCase {
  caseId: string;
  promptId: string;
  prompt: string;
  messages: readonly WorkloadMessage[];
  contextFiles: readonly string[];
  notes?: string | undefined;
}

export interface StarterWorkload {
  schemaVersion: number;
  workloadId: string;
  displayName: string;
  version: string;
  source: "built-in" | "filesystem";
  cases: readonly StarterWorkloadCase[];
  packRootDir?: string | undefined;
}

export const MAX_WORKLOAD_ID_LENGTH = 128;
export const WORKLOAD_ID_PATTERN = /^[a-z][a-z0-9-]*\.v[1-9][0-9]*$/;
export const DEFAULT_BUILT_IN_WORKLOAD_ID = "starter.v2";

const STARTER_V1_WORKLOAD_ID = "starter.v1";
const STARTER_V1_CASE_1_ID = "starter.v1.case-1";
const STARTER_V1_CASE_2_ID = "starter.v1.case-2";
const STARTER_V1_CASE_3_ID = "starter.v1.case-3";
const STARTER_V1_PROMPT_1_ID = "starter.prompt-1";
const STARTER_V1_PROMPT_2_ID = "starter.prompt-2";
const STARTER_V1_PROMPT_3_ID = "starter.prompt-3";

const STARTER_V2_WORKLOAD_ID = "starter.v2";

const TUNING_WORKLOAD_ID = "tuning.v1";
const TUNING_CASE_ID = "tuning.v1.case-1";
const TUNING_PROMPT_ID = "tuning.v1.prompt-1";
// Keep the built-in tuning prompt compact enough for v0.1.0 sweep defaults
// while preserving deterministic structure/hash guarantees.
const TUNING_RECORD_COUNT = 32;
const TUNING_PAYLOAD_TOKENS_PER_RECORD = 30;
const MAX_BUILT_IN_PROMPT_BYTES = 128 * 1024;
const KNUTH_HASH_MULTIPLIER = 2_654_435_761;
const KNUTH_HASH_XOR_MASK = 0x9e3779b9;

const TUNING_VOCABULARY = [
  "alto",
  "brio",
  "coda",
  "drum",
  "echo",
  "fret",
  "glow",
  "haze",
  "iris",
  "jade",
  "kilo",
  "luma",
  "moss",
  "nova",
  "onyx",
  "pith",
  "quip",
  "rune",
  "sable",
  "tide",
  "ulna",
  "vibe",
  "wisp",
  "xeno",
  "yarn",
  "zeal",
  "apex",
  "bolt",
  "crest",
  "dusk",
  "ember",
  "flare",
];

const BUILT_IN_WORKLOAD_PACKS: readonly WorkloadPackDefinition[] = [
  {
    schemaVersion: 1,
    workloadId: STARTER_V1_WORKLOAD_ID,
    displayName: "Starter workload v1",
    version: "1.0.0",
    prompts: [
      {
        caseId: STARTER_V1_CASE_1_ID,
        promptId: STARTER_V1_PROMPT_1_ID,
        messages: [
          {
            role: "user",
            content: "In one sentence, explain what an API is.",
          },
        ],
      },
      {
        caseId: STARTER_V1_CASE_2_ID,
        promptId: STARTER_V1_PROMPT_2_ID,
        messages: [
          {
            role: "user",
            content: "Name two practical uses for basic shell scripting.",
          },
        ],
      },
      {
        caseId: STARTER_V1_CASE_3_ID,
        promptId: STARTER_V1_PROMPT_3_ID,
        messages: [
          {
            role: "user",
            content: "Write one short tip for improving TypeScript error messages.",
          },
        ],
      },
    ],
  },
  {
    schemaVersion: 1,
    workloadId: STARTER_V2_WORKLOAD_ID,
    displayName: "Starter workload v2",
    version: "2.0.0",
    prompts: [
      {
        caseId: "starter.v2.case-1",
        promptId: "starter.v2.prompt-1",
        messages: [
          {
            role: "user",
            content: [
              "You are fixing a TypeScript helper and adding tests.",
              "",
              "Current code:",
              "function parseFlag(value?: string): boolean {",
              "  if (!value) return false;",
              "  return value.toLowerCase() === \"true\";",
              "}",
              "",
              "Bug: values \"1\", \"yes\", and \"TRUE\" should be true.",
              "",
              "Return exactly:",
              "1) Updated function code.",
              "2) Three focused tests (valid true values, explicit false values, empty/undefined).",
              "",
              "Use plain TypeScript and Bun test APIs only.",
            ].join("\n"),
          },
        ],
      },
      {
        caseId: "starter.v2.case-2",
        promptId: "starter.v2.prompt-2",
        messages: [
          {
            role: "user",
            content: [
              "Explain API architecture trade-offs for a run queue service.",
              "",
              "Constraints:",
              "- 1 worker process, max 1 active run.",
              "- Clients need progress updates.",
              "- Runs can last 10+ minutes.",
              "",
              "Compare two designs:",
              "A) synchronous POST /runs that blocks until done",
              "B) async POST /runs + GET /runs/:id + SSE progress stream",
              "",
              "Output format:",
              "- Decision: <A|B>",
              "- 3 trade-offs",
              "- 2 implementation cautions",
            ].join("\n"),
          },
        ],
      },
      {
        caseId: "starter.v2.case-3",
        promptId: "starter.v2.prompt-3",
        messages: [
          {
            role: "user",
            content: [
              "Transform the dataset into strict JSON output.",
              "",
              "Input records:",
              "alpha,passed,12",
              "beta,failed,3",
              "gamma,passed,8",
              "delta,passed,15",
              "",
              "Return one JSON object with:",
              "- totalRecords (number)",
              "- passedIds (array of ids sorted ascending)",
              "- failedIds (array of ids sorted ascending)",
              "- averageScorePassed (number rounded to 2 decimals)",
              "",
              "No markdown and no extra keys.",
            ].join("\n"),
          },
        ],
      },
      {
        caseId: "starter.v2.case-4",
        promptId: "starter.v2.prompt-4",
        messages: [
          {
            role: "user",
            content:
              "Draft a CLI help snippet for a `cache warm` command. Keep lines <= 80 chars and include exactly 2 examples.",
          },
          {
            role: "assistant",
            content: [
              "Usage: tool cache warm [options]",
              "Options:",
              "  --ttl <ms>     Cache TTL override",
              "  --profile <id> Target profile",
              "Examples:",
              "  tool cache warm --profile local",
              "  tool cache warm --profile ssh-lab --ttl 30000",
            ].join("\n"),
          },
          {
            role: "user",
            content:
              "Revise it: add a `--dry-run` option, keep prior constraints, and preserve command name.",
          },
        ],
      },
    ],
  },
  {
    schemaVersion: 1,
    workloadId: TUNING_WORKLOAD_ID,
    displayName: "Tuning workload v1",
    version: "1.0.0",
    prompts: [
      {
        caseId: TUNING_CASE_ID,
        promptId: TUNING_PROMPT_ID,
        messages: [
          {
            role: "user",
            content: buildTuningPrompt(),
          },
        ],
      },
    ],
  },
];

export function buildTuningPrompt(): string {
  const lines: string[] = [
    "Benchmark task: deterministic long-form generation over synthetic records.",
    "Read the dataset and follow the output instructions exactly.",
    "BEGIN_DATASET",
  ];

  for (let index = 0; index < TUNING_RECORD_COUNT; index += 1) {
    lines.push(buildTuningRecord(index));
  }

  lines.push("END_DATASET");
  lines.push("OUTPUT_INSTRUCTIONS");
  lines.push("- Produce exactly 512 lines.");
  lines.push(
    "- Use this exact format: OUT|<line_number>|<record_id>|<checksum>|<token_a>|<token_b>|<token_c>",
  );
  lines.push("- line_number must be zero-padded from 0001 through 0512.");
  lines.push("- Iterate records in dataset order and wrap back to the start when needed.");
  lines.push("- Copy token_a/token_b/token_c from each selected record payload.");
  lines.push("- Do not add commentary, headings, markdown, or blank lines.");

  return lines.join("\n");
}

function buildTuningRecord(index: number): string {
  const recordNumber = index + 1;
  const recordId = `rec-${recordNumber.toString().padStart(3, "0")}`;
  const cluster = Math.floor(index / 16)
    .toString()
    .padStart(2, "0");
  const bucket = (index % 16).toString().padStart(2, "0");
  // Deterministic non-cryptographic hash for synthetic record differentiation.
  const checksum = (((recordNumber * KNUTH_HASH_MULTIPLIER) >>> 0) ^ KNUTH_HASH_XOR_MASK)
    .toString(16)
    .padStart(8, "0");
  const payload = buildTuningPayload(recordNumber);

  return `${recordId}|c${cluster}|b${bucket}|h${checksum} ${payload}`;
}

function buildTuningPayload(recordNumber: number): string {
  const tokens: string[] = [];

  for (let offset = 0; offset < TUNING_PAYLOAD_TOKENS_PER_RECORD; offset += 1) {
    const vocabularyIndex =
      (recordNumber * 11 + offset * 7) % TUNING_VOCABULARY.length;
    const tokenBase = TUNING_VOCABULARY[vocabularyIndex];
    if (typeof tokenBase !== "string" || tokenBase.length === 0) {
      throw new Error(
        `Tuning vocabulary entry at index ${vocabularyIndex} must be a non-empty string.`,
      );
    }

    const suffix = ((recordNumber * 97 + offset * 13) % 1000)
      .toString()
      .padStart(3, "0");
    tokens.push(`${tokenBase}${suffix}`);
  }

  return tokens.join(" ");
}

function registerBuiltInWorkloads(
  workloads: readonly StarterWorkload[],
): ReadonlyMap<string, StarterWorkload> {
  const byId = new Map<string, StarterWorkload>();

  for (const workload of workloads) {
    if (byId.has(workload.workloadId)) {
      throw new Error(`Duplicate built-in workload ID '${workload.workloadId}'.`);
    }

    for (const workloadCase of workload.cases) {
      const promptBytes = Buffer.byteLength(workloadCase.prompt, "utf8");
      if (promptBytes > MAX_BUILT_IN_PROMPT_BYTES) {
        throw new Error(
          `Built-in prompt '${workloadCase.promptId}' exceeded ${MAX_BUILT_IN_PROMPT_BYTES} bytes (${promptBytes}).`,
        );
      }
    }

    byId.set(workload.workloadId, workload);
  }

  return byId;
}

const BUILT_IN_WORKLOADS = registerBuiltInWorkloads(
  BUILT_IN_WORKLOAD_PACKS.map((pack) => {
    return convertPackToStarterWorkload(pack, "built-in");
  }),
);

export function listBuiltInWorkloadPacks(): readonly WorkloadPackDefinition[] {
  return BUILT_IN_WORKLOAD_PACKS;
}

export function listBuiltInWorkloads(): readonly StarterWorkload[] {
  return [...BUILT_IN_WORKLOADS.values()];
}

export function convertPackToStarterWorkload(
  pack: WorkloadPackDefinition,
  source: "built-in" | "filesystem",
  packRootDir?: string,
): StarterWorkload {
  return {
    schemaVersion: pack.schemaVersion,
    workloadId: pack.workloadId,
    displayName: pack.displayName,
    version: pack.version,
    source,
    cases: pack.prompts.map((prompt) => {
      return {
        caseId: prompt.caseId,
        promptId: prompt.promptId,
        messages: prompt.messages,
        prompt: buildPromptText(prompt.messages),
        contextFiles: prompt.contextFiles ?? [],
        ...(prompt.notes
          ? {
              notes: prompt.notes,
            }
          : {}),
      };
    }),
    ...(packRootDir
      ? {
          packRootDir,
        }
      : {}),
  };
}

export function getBuiltInWorkload(workloadId: string): StarterWorkload | null {
  return BUILT_IN_WORKLOADS.get(workloadId) ?? null;
}

function buildPromptText(messages: readonly WorkloadMessage[]): string {
  if (messages.length === 1 && messages[0]?.role === "user") {
    return messages[0].content;
  }

  return messages
    .map((message) => {
      return `${message.role.toUpperCase()}:\n${message.content}`;
    })
    .join("\n\n");
}
