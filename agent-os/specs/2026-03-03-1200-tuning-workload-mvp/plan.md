# Tuning Workload MVP

## Objective

Provide a single built-in benchmark workload suitable for `llama-server` sweep tuning (including KV-cache and OOM sensitivity) for the v0.0.1 server MVP.

## Context

- v0.0.1 prioritizes server-side sweep execution over SSH with minimal dependencies.
- Workload packs, file-based context ingestion, and exporters are intentionally deferred.
- The tuning workload should be deterministic, stable-IDs, and “stressful enough” to surface unstable/oom-prone configurations.

## Deliverables

- One built-in workload with a stable `workloadId` (example: `tuning.v0_0_1`).
- Exactly one prompt/case with a stable `promptId` and `caseId`.
- Prompt content that:
  - drives a long-running completion (decode throughput signal)
  - includes enough structured context to be sensitive to context size / KV-cache allocations
  - is robust to temperature/seed variations (recommended default: deterministic params)
- Operator notes in this spec describing intended use (what it measures, what it does not).

## Non-goals

- File-based workload packs (`CHIMERA_WORKLOAD_ROOTS`).
- Context document ingestion.
- CSV/markdown export artifacts.
- Multiple prompts / benchmark suite design.

## Implementation tasks

1. Save spec documentation (this folder).
   - Ensure this spec folder contains:
     - `plan.md`
     - `shape.md`
     - `references.md`
     - `standards.md`
     - `visuals/README.md`

2. Add the built-in tuning workload.
   - Extend the built-in workload registry to include the new `workloadId`.
   - Keep IDs stable and human-readable.
   - Keep prompt text generated deterministically (either embedded text or a deterministic generator).

3. Add a smoke test and a manual curl example.
   - Verify `POST /runs` accepts the new `workloadId`.
   - Verify `runs/{runId}/result.json` contains the expected `workloadId` and prompt identifiers.

## Manual testing steps

1. Start the server.
2. Create a run using the tuning workload:

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:4096/runs \
  -d '{
    "engineId": "llama-cpp",
    "target": { "type": "ssh", "profileId": "lab" },
    "model": { "identifier": "/models/model.gguf" },
    "workloadId": "tuning.v0_0_1",
    "engine": { "serverArgs": [], "requestParams": {} },
    "validationMode": "permissive"
  }'
```

## Exit criteria

- A run can be created selecting the tuning workload and produces a normal `result.json` with the tuning workload identifiers.

## Dependencies

- `agent-os/specs/2026-02-23-1715-server-plugin-llama-cpp-foundation/`
