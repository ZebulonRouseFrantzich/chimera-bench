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
- Prompt stability hardening:
  - deterministic prompt generator with a built-in size cap (<= 128KiB)
  - unit tests that lock prompt shape + size and catch accidental drift
- SSH mixed-GPU safety:
  - on remote targets that expose multiple GPU devices, runs must include an explicit GPU selector in `engine.serverArgs` (for example `--device`, `--main-gpu`, or `--split-mode none`)
  - the server rejects mixed-GPU SSH runs without explicit GPU selection to avoid unstable auto multi-GPU startup behavior
  - when remote help output exposes concrete GPU choices, validation guidance surfaces detected `--device` identifiers and `--main-gpu` indexes
  - `--split-mode` satisfies this guard only when set to `none`; other split-mode values do not bypass mixed-GPU safety checks

## Workload Definition

### Stable IDs

- `workloadId`: `tuning.v0_0_1`
- `caseId`: `tuning.v0_0_1.case-1`
- `promptId`: `tuning.v0_0_1.prompt-1`

### Prompt Shape

- Implemented as a deterministic generator in `src/server/runs/starter-workload.ts` (`buildTuningPrompt()`).
- Approximate size (current implementation): ~70k chars and ~8k tokens via `estimateTokenCount()` (rough whitespace estimate).
- The prompt content does not embed a token estimate line; `contextTokens` in `result.json` is computed separately via `estimateTokenCount()`.
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

### SSH Mixed-GPU Note

Some remote hosts expose multiple GPU devices (for example a dGPU + iGPU). In those environments, `llama-server` auto-selection can be unstable.

For SSH targets with multiple GPUs, the server requires an explicit GPU selector in `engine.serverArgs`:

- `--device <identifier>` (example: `ROCm0`, `CUDA0`)
- `--main-gpu <index>` (example: `0`)
- `--split-mode none`

If you omit GPU selection on a mixed-GPU SSH target, `POST /runs` fails validation with `VALIDATION_ENGINE_OPTIONS_INVALID` and an issue code `SERVER_ARG_GPU_SELECTION_REQUIRED`.

If `--split-mode` is provided with a value other than `none`, the mixed-GPU guard still rejects the run unless `--device` or `--main-gpu` is also set.

`--device` and `--main-gpu` must include non-empty values to satisfy this guard.

When available, the validation issue and server console logs include detected options for both forms, for example:

- `Detected --device identifiers: ROCm0, ROCm1`
- `Detected --main-gpu values: 0, 1`

Scope note for v0.0.1:

- The guard validates selector presence + basic value shape (non-empty values; `--split-mode none` only).
- Selector membership validation against discovered candidates (for example rejecting `--device ROCm` while allowing `--device ROCm0`) is deferred to post-v0.0.1 follow-up work in `agent-os/specs/2026-02-23-1716-workload-packs-and-exports/plan.md`.

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
  - Fail fast on duplicate built-in `workloadId` registration.
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
  - Prompt hardening tests cover determinism, shape (256-record dataset), and the 128KiB size limit.
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
      "serverArgs": ["--ctx-size", "16384", "--device", "ROCm0"],
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
      "serverArgs": ["--ctx-size", "16384", "--device", "ROCm0"],
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

### Task 4: SSH Mixed-GPU Hardening

- Detect remote mixed-GPU environments via remote `llama-server --help` discovery.
- Reject SSH run configs that omit explicit GPU selection when multiple GPU devices are detected.
- Reject SSH run configs that provide `--device` / `--main-gpu` flags without non-empty values.
- Suggest both selector styles (`--device` and `--main-gpu`) when mixed-GPU is detected.
- Include detected selector candidates (when available) in validation guidance shown to users.
- Treat `--split-mode` as satisfying mixed-GPU safety only when value is `none`.
- Share remote help discovery results (flags + GPU hints) through one cache/in-flight path so strict validation + mixed-GPU guard do not perform duplicate SSH probes.
- Bound remote help cache growth (TTL sweep + max entries) to keep long-lived server memory usage stable.
- If GPU-hint discovery fails, keep validation fail-open but log explicit console guidance (`event=run.validation.gpu_selection_discovery_skipped`).
- Do not inject defaults; GPU selection belongs in per-target configuration or the caller's `engine.serverArgs`.

#### Manual testing

```bash
bun test tests/starter-engine.test.ts -t "requires explicit GPU selection on mixed-GPU SSH targets"
bun test tests/starter-engine.test.ts -t "does not treat non-none split-mode as sufficient mixed-GPU selection"
bun test tests/starter-engine.test.ts -t "shares one remote help probe between flags and GPU hint discovery"
```

Check server console output for `event=run.validation.gpu_selection_required` guidance when a mixed-GPU validation failure is triggered.

## Exit criteria

- A run can be created selecting the tuning workload and produces a normal `result.json` with the tuning workload identifiers.
- On mixed-GPU SSH targets, run creation is rejected unless `engine.serverArgs` includes an explicit GPU selector.

## Dependencies

- `agent-os/specs/2026-02-23-1715-server-plugin-llama-cpp-foundation/`
