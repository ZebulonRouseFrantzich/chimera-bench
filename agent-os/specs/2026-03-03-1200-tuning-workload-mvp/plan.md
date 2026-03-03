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

## Workload Definition

### Stable IDs

- `workloadId`: `tuning.v0_0_1`
- `caseId`: `tuning.v0_0_1.case-1`
- `promptId`: `tuning.v0_0_1.prompt-1`

### Prompt Shape

- Implemented as a deterministic generator in `src/server/runs/starter-workload.ts` (`buildTuningPrompt()`).
- Approximate size (current implementation): ~70k chars and ~8k tokens via `estimateTokenCount()` (rough whitespace estimate).
- Structure:
  - `BEGIN_DATASET` / `END_DATASET` sentinel lines.
  - 256 synthetic records with stable ordering and stable token payloads.
  - Output instructions that encourage a long, fixed-format decode (so `max_tokens` primarily controls runtime).
- Safety: prompt length is validated at registration time and must be <= 128KiB.

## Operator Notes

### What It Measures

- Decode throughput (tokens/sec) under a moderately large prompt.
- Sensitivity to context size / KV-cache allocation choices when sweeping `llama-server` launch flags.
- Crash/OOM behavior differences across launch configurations (especially for near-limit context sizes).

Practical note: treat `--ctx-size` (passed via `engine.serverArgs`) as the primary KV/OOM stress knob. Keep the prompt fixed at ~8k tokens so benchmark iteration time stays reasonable.

### What It Does Not Measure

- Model quality, reasoning correctness, or instruction-following.
- Tool usage, structured output reliability, or jailbreak resistance.
- Latency-to-first-token (TTFT) accurately (until deeper log parsing is implemented).

### Recommended Deterministic Params

Use these as a baseline when tuning to reduce output variance:

```json
{
  "temperature": 0,
  "top_p": 1,
  "seed": 1,
  "max_tokens": 2048,
  "stop": []
}
```

Notes:

- Increase `max_tokens` for longer decode windows.
- Set `timeouts.caseMs` higher than the default 2 minutes when running large-context or slow targets.

### Recommended Sweep Strategy

Use a two-pass approach to balance iteration speed with stress:

1) OOM/KV boundary pass (fast)

- Sweep `engine.serverArgs` across `--ctx-size` values (example: `8192`, `12288`, `16384`).
- Keep `max_tokens` small (example: `32`-`256`) so you mostly measure startup/prefill behavior and quickly detect OOM.
- Ensure `--ctx-size` comfortably exceeds prompt tokens + `max_tokens` to avoid early truncation confounding results.

2) Throughput pass (slower, fewer configs)

- On configs that survive the boundary pass, increase `max_tokens` (example: `1024`-`2048`) to measure decode throughput.

## Non-goals

- File-based workload packs (`CHIMERA_WORKLOAD_ROOTS`).
- Context document ingestion.
- CSV/markdown export artifacts.
- Multiple prompts / benchmark suite design.

## Implementation tasks

### Task 1: Finalize Spec Documentation

- Ensure this spec folder contains:
  - `plan.md`
  - `shape.md`
  - `references.md`
  - `standards.md`
  - `visuals/README.md`
- Ensure this `plan.md` includes:
  - stable IDs (workload/case/prompt)
  - operator notes (what it measures / what it does not)
  - recommended deterministic params
  - per-task manual testing steps

#### Manual testing

```bash
ls -la agent-os/specs/2026-03-03-1200-tuning-workload-mvp/
```

### Task 2: Add The Built-in Tuning Workload

- Update `src/server/runs/starter-workload.ts`:
  - Register a new built-in workload with `workloadId: "tuning.v0_0_1"`.
  - Define exactly one case with stable IDs.
  - Generate prompt text deterministically (embedded text or deterministic generator).
  - Enforce a maximum built-in prompt size (hard cap) so prompt edits cannot silently balloon.
- Keep default behavior unchanged:
  - `DEFAULT_WORKLOAD_ID` remains `starter.v1`.

#### Manual testing

```bash
bun -e "import { getBuiltInWorkload } from './src/server/runs/starter-workload.ts'; const w = getBuiltInWorkload('tuning.v0_0_1'); console.log(Boolean(w), w?.workloadId, w?.cases.length, w?.cases[0]?.caseId, w?.cases[0]?.promptId);"
```

### Task 3: Add Smoke Tests And Manual Curl Example

- Add automated tests:
  - `POST /runs` accepts `workloadId: "tuning.v0_0_1"`.
  - `runs/{runId}/result.json` contains `workloadId`, `caseId`, and `promptId` for the tuning workload.
  - Unknown `workloadId` returns `VALIDATION_WORKLOAD_INVALID`.
- Update this spec with a manual curl example that:
  - uses deterministic request params
  - sets a higher `timeouts.caseMs` than the 2-minute default when appropriate

#### Manual testing

Run the tests:

```bash
bun test tests/app-runs.test.ts
```

End-to-end (server + curl):

1) Start the server.
2) Create a run using the tuning workload:

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:4096/runs \
  -d '{
    "engineId": "llama-cpp",
    "target": { "type": "ssh", "profileId": "lab" },
    "model": { "identifier": "/models/model.gguf" },
    "workloadId": "tuning.v0_0_1",
    "engine": {
      "serverArgs": ["--ctx-size", "16384"],
      "requestParams": {
        "temperature": 0,
        "top_p": 1,
        "seed": 1,
        "max_tokens": 2048,
        "stop": []
      }
    },
    "timeouts": { "caseMs": 600000 },
    "validationMode": "permissive"
  }'
```

Quick OOM/KV boundary variant (faster iterations):

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD \
  -H 'Content-Type: application/json' \
  http://127.0.0.1:4096/runs \
  -d '{
    "engineId": "llama-cpp",
    "target": { "type": "ssh", "profileId": "lab" },
    "model": { "identifier": "/models/model.gguf" },
    "workloadId": "tuning.v0_0_1",
    "engine": {
      "serverArgs": ["--ctx-size", "16384"],
      "requestParams": { "temperature": 0, "top_p": 1, "seed": 1, "max_tokens": 64 }
    },
    "timeouts": { "caseMs": 300000 },
    "validationMode": "permissive"
  }'
```

3) Poll until terminal status:

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/runs/<runId>
```

4) Fetch the result:

```bash
curl -sS -u chimera:$CHIMERA_SERVER_PASSWORD http://127.0.0.1:4096/runs/<runId>/result
```

5) Inspect the persisted artifact:

```bash
cat runs/<runId>/result.json
```

## Exit criteria

- A run can be created selecting the tuning workload and produces a normal `result.json` with the tuning workload identifiers.

## Dependencies

- `agent-os/specs/2026-02-23-1715-server-plugin-llama-cpp-foundation/`
