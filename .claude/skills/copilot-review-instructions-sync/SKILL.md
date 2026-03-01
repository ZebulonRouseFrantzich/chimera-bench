---
name: copilot-review-instructions-sync
description: Update and validate GitHub Copilot review instruction files from Agent OS standards and repository conventions.
argument-hint: "[optional focus area such as server, cli, or tests]"
disable-model-invocation: true
---

Use this workflow when standards change and Copilot review instructions need to stay in sync.

## Standards to read first

- `agent-os/standards/index.yml`
- Any changed standards under `agent-os/standards/**`
- `AGENTS.md`

## Procedure

1. Inspect current Copilot instruction files:
   - `.github/copilot-instructions.md`
   - `.github/instructions/**/*.instructions.md`
2. Map standards to instruction scopes:
   - Repository-wide policy goes in `.github/copilot-instructions.md`.
   - Domain-specific policy goes in path-specific files with `applyTo` frontmatter.
3. Keep guidance concise and review-oriented:
   - Prioritize security, correctness, reliability, and performance.
   - Avoid style-only directives that create noisy reviews.
4. Ensure path-specific files have valid `applyTo` globs and no conflicting directives.
5. Validate practical review context is included:
   - CI parity commands (`bun run lint`, `bun run openapi:check`, `bun test`).
   - Contract-sync expectations for OpenAPI and SDK artifacts.
6. Enforce Copilot code review constraints:
   - Keep each custom instruction file under 4000 characters.
7. Report changes:
   - Which standards were reflected.
   - Which instruction files changed.
   - Any remaining standards not yet represented.

## Guardrails

- Keep instructions declarative and broadly applicable.
- Do not include secrets or environment-specific credentials.
- Prefer standards as source of truth; only encode procedural guidance in skills.
