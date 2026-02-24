# Spec 7 - Frontend Stack Decision (Vue vs Solid)

## Objective

Make an explicit frontend technology decision before building the benchmark client UI.

## Context

- Preference is Vue if possible.
- OpenCode currently uses Solid-based frontend packages.
- Project goal is architectural compatibility with an OpenCode-like server/client split.
- No visuals or mockups were provided during shaping.

## Deliverables

- Decision record with chosen stack and rationale.
- Evaluation matrix (developer velocity, ecosystem fit, SSR/build tooling, SDK ergonomics from OpenAPI `/doc`, SSE support, long-term maintainability).
- Risk/mitigation notes for the non-chosen option.
- Minimal client integration spike plan for the chosen stack.

## Standards applied

- `agent-os/standards/server/api-conventions.md`
- `agent-os/standards/runs/result-schema.md`

## Reference implementations

- OpenCode architecture and deployment model: `https://github.com/anomalyco/opencode`
- OpenCode server docs: `https://opencode.ai/docs/server/`
- OpenCode app package snapshot (Solid/Vite baseline): `https://raw.githubusercontent.com/anomalyco/opencode/dev/packages/app/package.json`
- OpenCode monorepo tooling snapshot: `https://raw.githubusercontent.com/anomalyco/opencode/dev/package.json`

## Non-goals

- Full client implementation.
- Visual design system definition.

## Decision tasks

1. Define evaluation criteria and scoring weights.
2. Evaluate Vue and Solid against server API integration needs.
3. Record final decision and migration fallback plan.
4. Update product docs/roadmap with final frontend stack.

## Exit criteria

- Frontend stack decision is documented and approved, unblocking client implementation.
