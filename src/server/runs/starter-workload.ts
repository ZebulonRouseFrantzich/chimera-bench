import { Buffer } from "node:buffer";

export interface StarterWorkloadCase {
  caseId: string;
  promptId: string;
  prompt: string;
}

export interface StarterWorkload {
  workloadId: string;
  cases: readonly StarterWorkloadCase[];
}

const STARTER_WORKLOAD_ID = "starter.v1";
const STARTER_CASE_1_ID = "starter.v1.case-1";
const STARTER_CASE_2_ID = "starter.v1.case-2";
const STARTER_CASE_3_ID = "starter.v1.case-3";
const STARTER_PROMPT_1_ID = "starter.prompt-1";
const STARTER_PROMPT_2_ID = "starter.prompt-2";
const STARTER_PROMPT_3_ID = "starter.prompt-3";

const TUNING_WORKLOAD_ID = "tuning.v0_0_1";
const TUNING_CASE_ID = "tuning.v0_0_1.case-1";
const TUNING_PROMPT_ID = "tuning.v0_0_1.prompt-1";
// Keep the built-in tuning prompt compact enough for v0.0.1 sweep defaults
// while preserving deterministic structure/hash guarantees.
const TUNING_RECORD_COUNT = 32;
const TUNING_PAYLOAD_TOKENS_PER_RECORD = 30;
const MAX_BUILT_IN_PROMPT_BYTES = 128 * 1024;
const KNUTH_HASH_MULTIPLIER = 2_654_435_761;
const KNUTH_HASH_XOR_MASK = 0x9e3779b9;

const STARTER_WORKLOAD: StarterWorkload = {
  workloadId: STARTER_WORKLOAD_ID,
  cases: [
    {
      caseId: STARTER_CASE_1_ID,
      promptId: STARTER_PROMPT_1_ID,
      prompt: "In one sentence, explain what an API is.",
    },
    {
      caseId: STARTER_CASE_2_ID,
      promptId: STARTER_PROMPT_2_ID,
      prompt: "Name two practical uses for basic shell scripting.",
    },
    {
      caseId: STARTER_CASE_3_ID,
      promptId: STARTER_PROMPT_3_ID,
      prompt: "Write one short tip for improving TypeScript error messages.",
    },
  ],
};

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

// Intentionally generated once at module load for stable shared prompt text.
const TUNING_WORKLOAD: StarterWorkload = {
  workloadId: TUNING_WORKLOAD_ID,
  cases: [
    {
      caseId: TUNING_CASE_ID,
      promptId: TUNING_PROMPT_ID,
      prompt: buildTuningPrompt(),
    },
  ],
};

const BUILT_IN_WORKLOADS = registerBuiltInWorkloads([
  STARTER_WORKLOAD,
  TUNING_WORKLOAD,
]);

export function getBuiltInWorkload(workloadId: string): StarterWorkload | null {
  return BUILT_IN_WORKLOADS.get(workloadId) ?? null;
}
