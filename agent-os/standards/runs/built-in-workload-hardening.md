# Built-in Workload Hardening

Built-in benchmark workloads must be stable, deterministic, and bounded.

IDs:

- Use explicit, stable IDs: `workloadId`, `caseId`, `promptId`.

Determinism:

- Prompt text must be deterministic (no randomness, no time, no env-dependent output).
- Prefer generating large prompts once at module load for stable shared text.

Prompt bounds:

- Each built-in workload must define a maximum prompt size in UTF-8 bytes.
- Enforce cap at registration time.
- Reject workloads whose prompt exceeds its cap.

Regression locking:

- Every built-in prompt must have a regression hash test:
  - `sha256(promptText)` equals a hard-coded expected hash.
- Add at least one prompt shape test (sentinels/counts/format rules).

Registry safety:

- Fail fast on duplicate built-in `workloadId` registration.
