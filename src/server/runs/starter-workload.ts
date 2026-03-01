export interface StarterWorkloadCase {
  caseId: string;
  promptId: string;
  prompt: string;
}

export interface StarterWorkload {
  workloadId: string;
  cases: readonly StarterWorkloadCase[];
}

const STARTER_WORKLOAD: StarterWorkload = {
  workloadId: "starter.v1",
  cases: [
    {
      caseId: "starter.v1.case-1",
      promptId: "starter.prompt-1",
      prompt: "In one sentence, explain what an API is.",
    },
    {
      caseId: "starter.v1.case-2",
      promptId: "starter.prompt-2",
      prompt: "Name two practical uses for basic shell scripting.",
    },
    {
      caseId: "starter.v1.case-3",
      promptId: "starter.prompt-3",
      prompt: "Write one short tip for improving TypeScript error messages.",
    },
  ],
};

export function getBuiltInWorkload(workloadId: string): StarterWorkload | null {
  if (workloadId === STARTER_WORKLOAD.workloadId) {
    return STARTER_WORKLOAD;
  }

  return null;
}
