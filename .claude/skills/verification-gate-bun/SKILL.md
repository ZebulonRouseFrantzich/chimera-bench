---
name: verification-gate-bun
description: Run the standard verification gate for this Bun + TypeScript repo and report pass/fail results clearly.
argument-hint: "[optional targeted tests or extra verification commands]"
disable-model-invocation: true
---

Run this verification workflow before handoff or merge.

## Procedure

1. Run baseline checks:
   - `bun run lint`
   - `bun test`
2. Run targeted checks for changed areas (if known):
   - Example: `bun test tests/app-engines.test.ts`
3. Run task/spec-specific manual checks when relevant:
   - Server smoke checks (for endpoint changes), such as authenticated `curl` against `/global/health` or `/engines`.
4. If a check fails:
   - Capture the failure details.
   - Apply safe, scoped fixes.
   - Re-run failed checks and then re-run the full suite.
5. Report results in a command matrix:
   - Command
   - Purpose
   - Status (`pass`/`fail`)
   - Notes on retries or follow-up needed

## Guardrails

- Never claim a check passed unless it was executed in this session.
- If a check cannot run (missing dependency, environment constraint), report it explicitly and provide a local reproduce command.
